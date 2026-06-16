import { globalState, UserDataType } from "../globalState";
import { getUrl, ProblemState } from "../shared";
import { createHeaders, DirectApiUnsupportedError, requestJson } from "./leetcode-http";

const DEFAULT_PAGE_SIZE: number = 100;
const PROBLEM_CATEGORIES: string[] = ["algorithms", "database", "shell", "concurrency"];

export interface IListProblemsOptions {
    needTranslation?: boolean;
    showLocked?: boolean;
}

export interface ILeetCodeProblem {
    acRate: number;
    companies: string[];
    difficulty: "Easy" | "Medium" | "Hard" | "Unknown";
    isFavorite: boolean;
    locked: boolean;
    questionFrontendId: string;
    questionId?: string;
    state: ProblemState;
    tags: string[];
    title: string;
    titleSlug: string;
}

export interface ILeetCodeCodeSnippet {
    code: string;
    lang: string;
    langSlug: string;
}

export interface ILeetCodeQuestionDetail {
    codeSnippets: ILeetCodeCodeSnippet[];
    content: string;
    difficulty: "Easy" | "Medium" | "Hard" | "Unknown";
    exampleTestcaseList: string[];
    hints: string[];
    questionFrontendId: string;
    questionId: string;
    sampleTestCase: string;
    stats?: string;
    title: string;
    titleSlug: string;
    topicTags: string[];
}

export interface ILeetCodeSession {
    acQuestions: number;
    acSubmits: number;
    active: boolean;
    id: string;
    name: string;
    questionAcceptanceRate: number;
    submissionAcceptanceRate: number;
    submittedQuestions: number;
    totalSubmits: number;
}

interface IGraphqlError {
    message?: string;
}

interface IGraphqlResponse<TData> {
    data?: TData;
    errors?: IGraphqlError[];
}

interface IGlobalQuestionListData {
    problemsetQuestionList?: {
        total?: number;
        questions?: IGlobalQuestionListItem[];
    };
}

interface IGlobalQuestionListItem {
    acRate?: number;
    difficulty?: string;
    frontendQuestionId?: string;
    isFavor?: boolean;
    paidOnly?: boolean;
    questionId?: string;
    status?: string | null;
    title?: string;
    titleSlug?: string;
    topicTags?: ITopicTag[];
}

interface ICnQuestionListData {
    problemsetQuestionList?: {
        hasMore?: boolean;
        questions?: ICnQuestionListItem[];
        total?: number;
    };
}

interface ICnQuestionListItem {
    acRate?: number;
    difficulty?: string;
    frontendQuestionId?: string;
    isFavor?: boolean;
    paidOnly?: boolean;
    status?: string | null;
    title?: string;
    titleCn?: string;
    titleSlug?: string;
    topicTags?: ITopicTag[];
}

interface ITopicTag {
    name?: string;
    nameTranslated?: string;
    slug?: string;
}

interface IQuestionDetailData {
    question?: IQuestionDetailItem;
}

interface IQuestionDetailItem {
    codeSnippets?: ILeetCodeCodeSnippet[];
    content?: string;
    difficulty?: string;
    exampleTestcaseList?: string[];
    hints?: string[];
    questionFrontendId?: string;
    questionId?: string;
    sampleTestCase?: string;
    stats?: string;
    title?: string;
    titleSlug?: string;
    topicTags?: ITopicTag[];
    translatedContent?: string;
}

interface IUserStatusData {
    userStatus?: UserDataType;
}

interface ISessionResponse {
    sessions?: ISessionItem[];
}

interface ISessionItem {
    ac_questions?: number;
    id?: number | string;
    is_active?: boolean;
    name?: string;
    submitted_questions?: number;
    total_acs?: number;
    total_submitted?: number;
}

export async function listProblems(options: IListProblemsOptions = {}): Promise<ILeetCodeProblem[]> {
    const cookie: string = getRequiredCookie();
    const problemsBySlug: { [titleSlug: string]: ILeetCodeProblem } = {};

    for (const categorySlug of PROBLEM_CATEGORIES) {
        const problems: ILeetCodeProblem[] = await listProblemsByCategory(categorySlug, cookie, options);
        for (const problem of problems) {
            if (!options.showLocked && problem.locked) {
                continue;
            }
            problemsBySlug[problem.titleSlug] = problem;
        }
    }

    return Object.keys(problemsBySlug)
        .map((titleSlug: string) => problemsBySlug[titleSlug])
        .sort((left: ILeetCodeProblem, right: ILeetCodeProblem) => numericId(left.questionFrontendId) - numericId(right.questionFrontendId));
}

// Full problem detail for display (description, code snippets, hints, tags).
// Distinct from the lighter getQuestionDetail() in leetcode-http.ts, which
// selects only the judge metadata (questionId, testcases, metaData) needed by
// the submit/test paths. Keep the two separate so the hot judge path stays lean.
export async function getQuestionDetail(titleSlug: string, needTranslation: boolean = true): Promise<ILeetCodeQuestionDetail> {
    const cookie: string = getRequiredCookie();
    const referer: string = `${getUrl("base")}/problems/${titleSlug}/`;
    const response: IGraphqlResponse<IQuestionDetailData> = await requestJson<IGraphqlResponse<IQuestionDetailData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query getQuestionDetail($titleSlug: String!) {",
                "  question(titleSlug: $titleSlug) {",
                "    codeSnippets { code lang langSlug }",
                "    content",
                "    difficulty",
                "    exampleTestcaseList",
                "    hints",
                "    questionFrontendId",
                "    questionId",
                "    sampleTestCase",
                "    stats",
                "    title",
                "    titleSlug",
                "    topicTags { name slug nameTranslated }",
                "    translatedContent",
                "  }",
                "}",
            ].join("\n"),
            variables: { titleSlug },
            operationName: "getQuestionDetail",
        },
    }, { label: "question detail" });

    assertNoGraphqlErrors(response, "question detail");
    const question: IQuestionDetailItem | undefined = response.data && response.data.question;
    if (!question) {
        throw new DirectApiUnsupportedError(`Cannot load LeetCode problem details for "${titleSlug}".`);
    }

    return mapQuestionDetail(question, needTranslation);
}

// Single source of truth for the signed-in user's status. Goes through
// requestJson so it inherits the axios -> curl Cloudflare fallback that the
// submit/test paths use (the former LcAxios-based query-user-data.ts had none).
export async function fetchUserStatus(): Promise<UserDataType> {
    const cookie: string = getRequiredCookie();
    const response: IGraphqlResponse<IUserStatusData> = await requestJson<IGraphqlResponse<IUserStatusData>>({
        method: "POST",
        url: getUrl("userGraphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/`),
        data: {
            query: [
                "query globalData {",
                "  userStatus {",
                "    isSignedIn",
                "    isPremium",
                "    isVerified",
                "    username",
                "    avatar",
                "  }",
                "}",
            ].join("\n"),
            variables: {},
            operationName: "globalData",
        },
    }, { label: "user status" });

    assertNoGraphqlErrors(response, "user status");
    const userStatus: UserDataType | undefined = response.data && response.data.userStatus;
    if (!userStatus) {
        throw new DirectApiUnsupportedError("LeetCode did not return user status.");
    }

    return userStatus;
}

export async function listSessions(): Promise<ILeetCodeSession[]> {
    const cookie: string = getRequiredCookie();
    const response: ISessionResponse = await requestJson<ISessionResponse>({
        method: "POST",
        url: `${getUrl("base")}/session/`,
        headers: createHeaders(cookie, `${getUrl("base")}/session/`),
        data: {},
    }, { label: "list sessions" });

    return (response.sessions || []).map(mapSession);
}

export async function activateSession(sessionId: string): Promise<ILeetCodeSession[]> {
    return updateSession("PUT", { func: "activate", target: sessionId }, "activate session");
}

export async function createSession(name: string): Promise<ILeetCodeSession[]> {
    return updateSession("PUT", { func: "create", name }, "create session");
}

export async function deleteSession(sessionId: string): Promise<ILeetCodeSession[]> {
    return updateSession("DELETE", { target: sessionId }, "delete session");
}

export function mapGlobalProblem(raw: IGlobalQuestionListItem): ILeetCodeProblem {
    return {
        acRate: raw.acRate || 0,
        companies: [],
        difficulty: normalizeDifficulty(raw.difficulty),
        isFavorite: !!raw.isFavor,
        locked: !!raw.paidOnly,
        questionFrontendId: raw.frontendQuestionId || "",
        questionId: raw.questionId,
        state: normalizeProblemState(raw.status),
        tags: mapTags(raw.topicTags, false),
        title: raw.title || "",
        titleSlug: raw.titleSlug || "",
    };
}

export function mapCnProblem(raw: ICnQuestionListItem, needTranslation: boolean): ILeetCodeProblem {
    return {
        acRate: toPercentage(raw.acRate),
        companies: [],
        difficulty: normalizeDifficulty(raw.difficulty),
        isFavorite: !!raw.isFavor,
        locked: !!raw.paidOnly,
        questionFrontendId: raw.frontendQuestionId || "",
        state: normalizeProblemState(raw.status),
        tags: mapTags(raw.topicTags, needTranslation),
        title: (needTranslation && raw.titleCn ? raw.titleCn : raw.title) || "",
        titleSlug: raw.titleSlug || "",
    };
}

export function mapQuestionDetail(raw: IQuestionDetailItem, needTranslation: boolean): ILeetCodeQuestionDetail {
    const content: string = needTranslation && raw.translatedContent ? raw.translatedContent : raw.content || "";
    return {
        codeSnippets: raw.codeSnippets || [],
        content,
        difficulty: normalizeDifficulty(raw.difficulty),
        exampleTestcaseList: raw.exampleTestcaseList || [],
        hints: raw.hints || [],
        questionFrontendId: raw.questionFrontendId || "",
        questionId: raw.questionId || "",
        sampleTestCase: raw.sampleTestCase || "",
        stats: raw.stats,
        title: raw.title || "",
        titleSlug: raw.titleSlug || "",
        topicTags: mapTags(raw.topicTags, needTranslation),
    };
}

export function formatAcceptanceRate(acRate: number): string {
    return `${acRate.toFixed(2)} %`;
}

async function listProblemsByCategory(categorySlug: string, cookie: string, options: IListProblemsOptions): Promise<ILeetCodeProblem[]> {
    const problems: ILeetCodeProblem[] = [];
    let skip: number = 0;
    let total: number | undefined;
    let hasMore: boolean = true;

    while (hasMore) {
        const page: IProblemPage = await fetchProblemPage(categorySlug, skip, DEFAULT_PAGE_SIZE, cookie, options.needTranslation !== false);
        problems.push(...page.problems);
        total = page.total;
        skip += DEFAULT_PAGE_SIZE;
        hasMore = page.hasMore && (total === undefined || skip < total);
    }

    return problems;
}

async function fetchProblemPage(categorySlug: string, skip: number, limit: number, cookie: string, needTranslation: boolean): Promise<IProblemPage> {
    return isCnEndpoint()
        ? fetchCnProblemPage(categorySlug, skip, limit, cookie, needTranslation)
        : fetchGlobalProblemPage(categorySlug, skip, limit, cookie);
}

async function fetchGlobalProblemPage(categorySlug: string, skip: number, limit: number, cookie: string): Promise<IProblemPage> {
    const response: IGraphqlResponse<IGlobalQuestionListData> = await requestJson<IGraphqlResponse<IGlobalQuestionListData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/problemset/`),
        data: {
            query: [
                "query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {",
                "  problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {",
                "    total: totalNum",
                "    questions: data {",
                "      acRate",
                "      difficulty",
                "      frontendQuestionId: questionFrontendId",
                "      isFavor",
                "      paidOnly: isPaidOnly",
                "      questionId",
                "      status",
                "      title",
                "      titleSlug",
                "      topicTags { name slug }",
                "    }",
                "  }",
                "}",
            ].join("\n"),
            variables: { categorySlug, skip, limit, filters: {} },
            operationName: "problemsetQuestionList",
        },
    }, { label: "global problem list" });

    assertNoGraphqlErrors(response, "global problem list");
    const list = response.data && response.data.problemsetQuestionList;
    const questions: IGlobalQuestionListItem[] = list && list.questions || [];
    return {
        hasMore: questions.length >= limit,
        problems: questions.map(mapGlobalProblem).filter(hasProblemIdentity),
        total: list && list.total,
    };
}

async function fetchCnProblemPage(categorySlug: string, skip: number, limit: number, cookie: string, needTranslation: boolean): Promise<IProblemPage> {
    const response: IGraphqlResponse<ICnQuestionListData> = await requestJson<IGraphqlResponse<ICnQuestionListData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/problemset/`),
        data: {
            query: [
                "query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {",
                "  problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {",
                "    hasMore",
                "    total",
                "    questions {",
                "      acRate",
                "      difficulty",
                "      frontendQuestionId",
                "      isFavor",
                "      paidOnly",
                "      status",
                "      title",
                "      titleCn",
                "      titleSlug",
                "      topicTags { name nameTranslated slug }",
                "    }",
                "  }",
                "}",
            ].join("\n"),
            variables: { categorySlug, skip, limit, filters: {} },
            operationName: "problemsetQuestionList",
        },
    }, { label: "cn problem list" });

    assertNoGraphqlErrors(response, "cn problem list");
    const list = response.data && response.data.problemsetQuestionList;
    const questions: ICnQuestionListItem[] = list && list.questions || [];
    return {
        hasMore: list ? !!list.hasMore : questions.length >= limit,
        problems: questions.map((question: ICnQuestionListItem) => mapCnProblem(question, needTranslation)).filter(hasProblemIdentity),
        total: list && list.total,
    };
}

async function updateSession(method: "PUT" | "DELETE", data: object, label: string): Promise<ILeetCodeSession[]> {
    const cookie: string = getRequiredCookie();
    const response: ISessionResponse = await requestJson<ISessionResponse>({
        method,
        url: `${getUrl("base")}/session/`,
        headers: createHeaders(cookie, `${getUrl("base")}/session/`),
        data,
    }, { label });

    return (response.sessions || []).map(mapSession);
}

export function mapSession(raw: ISessionItem): ILeetCodeSession {
    const acQuestions: number = raw.ac_questions || 0;
    const submittedQuestions: number = raw.submitted_questions || 0;
    const acSubmits: number = raw.total_acs || 0;
    const totalSubmits: number = raw.total_submitted || 0;
    return {
        acQuestions,
        acSubmits,
        active: !!raw.is_active,
        id: raw.id === undefined ? "" : String(raw.id),
        name: raw.name || "Anonymous Session",
        questionAcceptanceRate: submittedQuestions > 0 ? acQuestions * 100 / submittedQuestions : 0,
        submissionAcceptanceRate: totalSubmits > 0 ? acSubmits * 100 / totalSubmits : 0,
        submittedQuestions,
        totalSubmits,
    };
}

function assertNoGraphqlErrors(response: IGraphqlResponse<unknown>, label: string): void {
    if (!response.errors || response.errors.length === 0) {
        return;
    }

    const message: string = response.errors
        .map((error: IGraphqlError) => error.message || "unknown GraphQL error")
        .join("; ");
    throw new DirectApiUnsupportedError(`LeetCode GraphQL ${label} failed: ${message}.`, false);
}

function getRequiredCookie(): string {
    const cookie: string | undefined = globalState.getCookie();
    if (!cookie) {
        throw new DirectApiUnsupportedError("No synced LeetCode cookie is available.");
    }

    return cookie;
}

function hasProblemIdentity(problem: ILeetCodeProblem): boolean {
    return !!problem.questionFrontendId && !!problem.titleSlug;
}

function isCnEndpoint(): boolean {
    return getUrl("base").indexOf("leetcode.cn") >= 0;
}

function mapTags(tags: ITopicTag[] | undefined, needTranslation: boolean): string[] {
    if (!tags || tags.length === 0) {
        return [];
    }

    return tags
        .map((tag: ITopicTag) => (needTranslation && tag.nameTranslated ? tag.nameTranslated : tag.slug || tag.name || "").trim())
        .filter((tag: string) => !!tag);
}

function normalizeDifficulty(value: string | undefined): "Easy" | "Medium" | "Hard" | "Unknown" {
    switch ((value || "").toLowerCase()) {
        case "easy":
            return "Easy";
        case "medium":
            return "Medium";
        case "hard":
            return "Hard";
        default:
            return "Unknown";
    }
}

function normalizeProblemState(value: string | null | undefined): ProblemState {
    switch ((value || "").toLowerCase()) {
        case "ac":
        case "accepted":
            return ProblemState.AC;
        case "notac":
        case "tried":
            return ProblemState.NotAC;
        default:
            return ProblemState.Unknown;
    }
}

function numericId(value: string): number {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function toPercentage(value: number | undefined): number {
    if (!value) {
        return 0;
    }

    return value > 1 ? value : value * 100;
}

interface IProblemPage {
    hasMore: boolean;
    problems: ILeetCodeProblem[];
    total?: number;
}
