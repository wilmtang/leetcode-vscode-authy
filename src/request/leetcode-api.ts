import { globalState, IBrowserRequestHeaders, UserDataType } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { getUrl, ProblemState } from "../shared";
import { createHeaders, DirectApiUnsupportedError, requestJson } from "./leetcode-http";

const DEFAULT_PAGE_SIZE: number = 100;
const PROBLEM_CATEGORIES: string[] = ["algorithms", "database", "shell", "concurrency"];
// Max concurrent problem-list page requests. Keeps the full-catalog fetch fast
// without hammering LeetCode with ~39 simultaneous requests.
const PROBLEM_LIST_CONCURRENCY: number = 8;

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
    categoryTitle: string;
    codeSnippets: ILeetCodeCodeSnippet[];
    content: string;
    difficulty: "Easy" | "Medium" | "Hard" | "Unknown";
    dislikes: number;
    exampleTestcaseList: string[];
    hints: string[];
    likes: number;
    questionFrontendId: string;
    questionId: string;
    sampleTestCase: string;
    stats?: string;
    title: string;
    titleSlug: string;
    topicTags: string[];
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
    questionId?: string;
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

// Shape of the legacy bulk REST endpoint (GET /api/problems/all/). It returns the
// entire catalog in one response — no tags/companies (those are vendored), but
// everything the explorer needs.
interface IRestProblemStat {
    stat?: {
        question_id?: number;
        frontend_question_id?: number | string;
        question__title?: string;
        question__title_slug?: string;
        total_acs?: number;
        total_submitted?: number;
    };
    difficulty?: { level?: number };
    paid_only?: boolean;
    status?: string | null;
    is_favor?: boolean;
}

interface IRestProblemsResponse {
    stat_status_pairs?: IRestProblemStat[];
}

interface IQuestionDetailData {
    question?: IQuestionDetailItem;
}

interface IQuestionDetailItem {
    categoryTitle?: string;
    codeSnippets?: ILeetCodeCodeSnippet[];
    content?: string;
    difficulty?: string;
    dislikes?: number;
    exampleTestcaseList?: string[];
    hints?: string[];
    likes?: number;
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

// ---------------------------------------------------------------------------
// User profile (status bar / "personal info" panel)
//
// Public-profile aggregate that backs the leetcode.com/u/<user>/ page and the
// /progress/ dashboard. Composed from four GraphQL queries: userPublicProfile
// (ranking, real name, country/company), userProblemsSolved (catalog totals
// and AC counts per difficulty plus beats %), recentAcSubmissions (last N
// Accepted), and languageStats (solved-by-language). The matcher keeps each
// piece independent so a single transient failure does not collapse the panel.
// ---------------------------------------------------------------------------

export type Difficulty = "All" | "Easy" | "Medium" | "Hard";

export interface ILeetCodeDifficultyCount {
    difficulty: Difficulty;
    count: number;
}

export interface ILeetCodeBeats {
    difficulty: "Easy" | "Medium" | "Hard";
    percentage: number;
}

export interface ILeetCodeLanguageCount {
    languageName: string;
    problemsSolved: number;
}

export interface ILeetCodeRecentSubmission {
    id: string;
    title: string;
    titleSlug: string;
    // Unix seconds (LeetCode returns the timestamp as a string).
    timestamp: number;
}

export interface ILeetCodeUserProfile {
    username: string;
    realName: string;
    avatar: string;
    ranking: number | undefined;
    countryName: string;
    company: string;
    school: string;
    reputation: number;
    // Catalog size by difficulty (e.g. 3,962 problems total). Empty if LeetCode
    // omits it (rare; older accounts).
    totalsByDifficulty: ILeetCodeDifficultyCount[];
    // Solved-AC counts by difficulty. Always contains an "All" entry, even when
    // LeetCode omits it (computed from the three difficulties).
    solvedByDifficulty: ILeetCodeDifficultyCount[];
    beatsByDifficulty: ILeetCodeBeats[];
    languageProblemCount: ILeetCodeLanguageCount[];
    recentAcSubmissions: ILeetCodeRecentSubmission[];
}

interface IUserPublicProfileData {
    matchedUser?: {
        username?: string;
        profile?: {
            ranking?: number;
            userAvatar?: string;
            realName?: string;
            countryName?: string;
            company?: string;
            school?: string;
            reputation?: number;
        };
    };
}

interface IUserProblemsSolvedData {
    allQuestionsCount?: Array<{ difficulty?: string; count?: number }>;
    matchedUser?: {
        problemsSolvedBeatsStats?: Array<{ difficulty?: string; percentage?: number }>;
        submitStatsGlobal?: {
            acSubmissionNum?: Array<{ difficulty?: string; count?: number }>;
        };
    };
}

interface IRecentAcSubmissionsData {
    recentAcSubmissionList?: Array<{
        id?: string;
        title?: string;
        titleSlug?: string;
        timestamp?: string | number;
    }>;
}

interface ILanguageStatsData {
    matchedUser?: {
        languageProblemCount?: Array<{ languageName?: string; problemsSolved?: number }>;
    };
}

export async function listProblems(options: IListProblemsOptions = {}): Promise<ILeetCodeProblem[]> {
    const cookie: string = getRequiredCookie();

    // Fast path: the legacy bulk REST endpoint (the same one the CLI used) returns
    // the *entire* catalog in a single ~1s request. It carries no translated
    // titles, so only the `leetcode.cn` + translation case needs the paginated
    // GraphQL path; on any REST failure we also fall back to GraphQL.
    if (!(isCnEndpoint() && options.needTranslation !== false)) {
        try {
            return await listProblemsViaRest(cookie, options);
        } catch (error) {
            leetCodeChannel.appendLine(`[problems] Bulk REST list unavailable, falling back to GraphQL: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return listProblemsViaGraphql(cookie, options);
}

async function listProblemsViaRest(cookie: string, options: IListProblemsOptions): Promise<ILeetCodeProblem[]> {
    const response: IRestProblemsResponse = await requestJson<IRestProblemsResponse>({
        method: "GET",
        url: `${getUrl("base")}/api/problems/all/`,
        headers: createHeaders(cookie, `${getUrl("base")}/problemset/all/`),
    }, { label: "problem list" });

    const problemsBySlug: { [titleSlug: string]: ILeetCodeProblem } = {};
    for (const pair of response.stat_status_pairs || []) {
        const problem: ILeetCodeProblem = mapRestProblem(pair);
        if (!hasProblemIdentity(problem) || (!options.showLocked && problem.locked)) {
            continue;
        }
        problemsBySlug[problem.titleSlug] = problem;
    }

    return sortByFrontendId(problemsBySlug);
}

async function listProblemsViaGraphql(cookie: string, options: IListProblemsOptions): Promise<ILeetCodeProblem[]> {
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

    return sortByFrontendId(problemsBySlug);
}

function sortByFrontendId(problemsBySlug: { [titleSlug: string]: ILeetCodeProblem }): ILeetCodeProblem[] {
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
    // `nameTranslated` only exists on the leetcode.cn TopicTagNode schema; the
    // global (.com) endpoint rejects the whole query with HTTP 400 if it's
    // requested. Mirror the endpoint split the list queries already make.
    const topicTagSelection: string = isCnEndpoint()
        ? "    topicTags { name slug nameTranslated }"
        : "    topicTags { name slug }";
    const response: IGraphqlResponse<IQuestionDetailData> = await requestJson<IGraphqlResponse<IQuestionDetailData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query getQuestionDetail($titleSlug: String!) {",
                "  question(titleSlug: $titleSlug) {",
                "    categoryTitle",
                "    codeSnippets { code lang langSlug }",
                "    content",
                "    difficulty",
                "    dislikes",
                "    exampleTestcaseList",
                "    hints",
                "    likes",
                "    questionFrontendId",
                "    questionId",
                "    sampleTestCase",
                "    stats",
                "    title",
                "    titleSlug",
                topicTagSelection,
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
export async function fetchUserStatus(
    cookieOverride?: string,
    browserUserAgent?: string,
    browserRequestHeaders?: IBrowserRequestHeaders,
): Promise<UserDataType> {
    const cookie: string = cookieOverride || getRequiredCookie();
    const response: IGraphqlResponse<IUserStatusData> = await requestJson<IGraphqlResponse<IUserStatusData>>({
        method: "POST",
        url: getUrl("userGraphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/`, {
            browserRequestHeaders,
            browserUserAgent,
        }),
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

// Aggregates the four public-profile queries the leetcode.com/u/<user>/ page
// fires, in parallel, degrading any single failure to an empty section.
//
// NOTE (A2-12): the profile *panel* does NOT use this — commands/profile.ts calls
// the four per-section fetchers (fetchProfileIdentity/Stats/Recent/Languages) so
// each section renders the moment it lands. This aggregate is kept only as
// test-support for the live integration test (leetcode-api.live.ts) and as the
// composition exercised by the mapUserProfile unit tests. Prefer the per-section
// fetchers for any new live caller; don't wire this into the UI.
export async function fetchUserProfile(username: string): Promise<ILeetCodeUserProfile> {
    if (!username) {
        throw new DirectApiUnsupportedError("Cannot fetch a LeetCode profile without a username.");
    }

    const cookie: string = getRequiredCookie();
    const referer: string = `${getUrl("base")}/u/${encodeURIComponent(username)}/`;

    const [publicProfile, solved, recent, languages] = await Promise.all([
        fetchUserPublicProfile(username, cookie, referer).catch((error: Error) => {
            leetCodeChannel.appendLine(`[profile] userPublicProfile failed: ${error.message}`);
            return undefined;
        }),
        fetchUserProblemsSolved(username, cookie, referer).catch((error: Error) => {
            leetCodeChannel.appendLine(`[profile] userProblemsSolved failed: ${error.message}`);
            return undefined;
        }),
        fetchRecentAcSubmissions(username, cookie, referer, 15).catch((error: Error) => {
            leetCodeChannel.appendLine(`[profile] recentAcSubmissions failed: ${error.message}`);
            return undefined;
        }),
        fetchLanguageStats(username, cookie, referer).catch((error: Error) => {
            leetCodeChannel.appendLine(`[profile] languageStats failed: ${error.message}`);
            return undefined;
        }),
    ]);

    return mapUserProfile({
        username,
        publicProfile,
        solved,
        recent,
        languages,
    });
}

// Section-level fetchers. Each does one GraphQL round-trip and maps just its own
// slice, so a caller can fire all four independently and render each the moment
// it lands (see commands/profile.ts) instead of awaiting the whole aggregate.
// They throw on failure; the caller decides whether that degrades one section or
// the panel.
export async function fetchProfileIdentity(username: string): Promise<IProfileIdentity> {
    const { cookie, referer } = profileRequestContext(username);
    return mapProfileIdentity(username, await fetchUserPublicProfile(username, cookie, referer));
}

export async function fetchProfileStats(username: string): Promise<IProfileStats> {
    const { cookie, referer } = profileRequestContext(username);
    return mapProfileStats(await fetchUserProblemsSolved(username, cookie, referer));
}

export async function fetchProfileRecent(username: string): Promise<IProfileRecent> {
    const { cookie, referer } = profileRequestContext(username);
    return mapProfileRecent(await fetchRecentAcSubmissions(username, cookie, referer, 15));
}

export async function fetchProfileLanguages(username: string): Promise<IProfileLanguages> {
    const { cookie, referer } = profileRequestContext(username);
    return mapProfileLanguages(await fetchLanguageStats(username, cookie, referer));
}

function profileRequestContext(username: string): { cookie: string; referer: string } {
    if (!username) {
        throw new DirectApiUnsupportedError("Cannot fetch a LeetCode profile without a username.");
    }
    return {
        cookie: getRequiredCookie(),
        referer: `${getUrl("base")}/u/${encodeURIComponent(username)}/`,
    };
}

async function fetchUserPublicProfile(username: string, cookie: string, referer: string): Promise<IUserPublicProfileData> {
    const response: IGraphqlResponse<IUserPublicProfileData> = await requestJson<IGraphqlResponse<IUserPublicProfileData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query userPublicProfile($username: String!) {",
                "  matchedUser(username: $username) {",
                "    username",
                "    profile {",
                "      ranking",
                "      userAvatar",
                "      realName",
                "      countryName",
                "      company",
                "      school",
                "      reputation",
                "    }",
                "  }",
                "}",
            ].join("\n"),
            variables: { username },
            operationName: "userPublicProfile",
        },
    }, { label: "user public profile" });
    assertNoGraphqlErrors(response, "user public profile");
    return response.data || {};
}

async function fetchUserProblemsSolved(username: string, cookie: string, referer: string): Promise<IUserProblemsSolvedData> {
    const response: IGraphqlResponse<IUserProblemsSolvedData> = await requestJson<IGraphqlResponse<IUserProblemsSolvedData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query userProblemsSolved($username: String!) {",
                "  allQuestionsCount { difficulty count }",
                "  matchedUser(username: $username) {",
                "    problemsSolvedBeatsStats { difficulty percentage }",
                "    submitStatsGlobal { acSubmissionNum { difficulty count } }",
                "  }",
                "}",
            ].join("\n"),
            variables: { username },
            operationName: "userProblemsSolved",
        },
    }, { label: "user problems solved" });
    assertNoGraphqlErrors(response, "user problems solved");
    return response.data || {};
}

async function fetchRecentAcSubmissions(username: string, cookie: string, referer: string, limit: number): Promise<IRecentAcSubmissionsData> {
    const response: IGraphqlResponse<IRecentAcSubmissionsData> = await requestJson<IGraphqlResponse<IRecentAcSubmissionsData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query recentAcSubmissions($username: String!, $limit: Int!) {",
                "  recentAcSubmissionList(username: $username, limit: $limit) {",
                "    id",
                "    title",
                "    titleSlug",
                "    timestamp",
                "  }",
                "}",
            ].join("\n"),
            variables: { username, limit },
            operationName: "recentAcSubmissions",
        },
    }, { label: "recent AC submissions" });
    assertNoGraphqlErrors(response, "recent AC submissions");
    return response.data || {};
}

async function fetchLanguageStats(username: string, cookie: string, referer: string): Promise<ILanguageStatsData> {
    const response: IGraphqlResponse<ILanguageStatsData> = await requestJson<IGraphqlResponse<ILanguageStatsData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query languageStats($username: String!) {",
                "  matchedUser(username: $username) {",
                "    languageProblemCount { languageName problemsSolved }",
                "  }",
                "}",
            ].join("\n"),
            variables: { username },
            operationName: "languageStats",
        },
    }, { label: "language stats" });
    assertNoGraphqlErrors(response, "language stats");
    return response.data || {};
}

export interface IUserProfileRawInputs {
    username: string;
    publicProfile?: IUserPublicProfileData;
    solved?: IUserProblemsSolvedData;
    recent?: IRecentAcSubmissionsData;
    languages?: ILanguageStatsData;
}

// The four independent slices of a profile. Each backs exactly one GraphQL
// query and one panel section, so they can be fetched, mapped, and rendered on
// their own without waiting for the others. `ILeetCodeUserProfile` is the union
// of all four (kept for the aggregate `fetchUserProfile`/`mapUserProfile` path).
export interface IProfileIdentity {
    username: string;
    realName: string;
    avatar: string;
    ranking: number | undefined;
    countryName: string;
    company: string;
    school: string;
    reputation: number;
}

export interface IProfileStats {
    totalsByDifficulty: ILeetCodeDifficultyCount[];
    solvedByDifficulty: ILeetCodeDifficultyCount[];
    beatsByDifficulty: ILeetCodeBeats[];
}

export interface IProfileRecent {
    recentAcSubmissions: ILeetCodeRecentSubmission[];
}

export interface IProfileLanguages {
    languageProblemCount: ILeetCodeLanguageCount[];
}

// Combines the four raw GraphQL payloads into a single, always-shaped object.
// Exported so the unit tests (and any future caller that pre-fetches the pieces
// in parallel) can exercise the mapping without touching the network.
export function mapUserProfile(inputs: IUserProfileRawInputs): ILeetCodeUserProfile {
    return {
        ...mapProfileIdentity(inputs.username, inputs.publicProfile),
        ...mapProfileStats(inputs.solved),
        ...mapProfileRecent(inputs.recent),
        ...mapProfileLanguages(inputs.languages),
    };
}

// Identity / "About" slice — ranking, real name, avatar, country/company/school.
export function mapProfileIdentity(fallbackUsername: string, data?: IUserPublicProfileData): IProfileIdentity {
    const matched = (data && data.matchedUser) || {};
    const profile = matched.profile || {};
    return {
        username: matched.username || fallbackUsername,
        realName: profile.realName || "",
        avatar: profile.userAvatar || "",
        ranking: typeof profile.ranking === "number" && profile.ranking > 0 ? profile.ranking : undefined,
        countryName: profile.countryName || "",
        company: profile.company || "",
        school: profile.school || "",
        reputation: typeof profile.reputation === "number" ? profile.reputation : 0,
    };
}

// Solved-problem slice — catalog totals, AC counts, and beats % by difficulty.
export function mapProfileStats(data?: IUserProblemsSolvedData): IProfileStats {
    const totalsByDifficulty: ILeetCodeDifficultyCount[] = mapDifficultyCounts((data && data.allQuestionsCount) || []);

    const rawAcCounts: ILeetCodeDifficultyCount[] = mapDifficultyCounts(
        (data && data.matchedUser && data.matchedUser.submitStatsGlobal && data.matchedUser.submitStatsGlobal.acSubmissionNum) || [],
    );
    const solvedByDifficulty: ILeetCodeDifficultyCount[] = ensureAllAggregate(rawAcCounts);

    const beatsByDifficulty: ILeetCodeBeats[] = ((data && data.matchedUser && data.matchedUser.problemsSolvedBeatsStats) || [])
        .map((entry: { difficulty?: string; percentage?: number }): ILeetCodeBeats | undefined => {
            const difficulty: "Easy" | "Medium" | "Hard" | undefined = mapBeatsDifficulty(entry.difficulty);
            if (!difficulty) {
                return undefined;
            }
            return {
                difficulty,
                percentage: typeof entry.percentage === "number" ? entry.percentage : 0,
            };
        })
        .filter((entry: ILeetCodeBeats | undefined): entry is ILeetCodeBeats => entry !== undefined);

    return { totalsByDifficulty, solvedByDifficulty, beatsByDifficulty };
}

// Recent-AC slice — last N Accepted submissions, blank-title rows dropped.
export function mapProfileRecent(data?: IRecentAcSubmissionsData): IProfileRecent {
    const recentAcSubmissions: ILeetCodeRecentSubmission[] = ((data && data.recentAcSubmissionList) || [])
        .map((entry: { id?: string; title?: string; titleSlug?: string; timestamp?: string | number }): ILeetCodeRecentSubmission => ({
            id: entry.id || "",
            title: entry.title || "",
            titleSlug: entry.titleSlug || "",
            timestamp: normalizeTimestamp(entry.timestamp),
        }))
        .filter((entry: ILeetCodeRecentSubmission) => entry.title.length > 0);

    return { recentAcSubmissions };
}

// Language slice — solved-count per language, zero-counts dropped, sorted desc.
export function mapProfileLanguages(data?: ILanguageStatsData): IProfileLanguages {
    const languageProblemCount: ILeetCodeLanguageCount[] = ((data && data.matchedUser && data.matchedUser.languageProblemCount) || [])
        .map((entry: { languageName?: string; problemsSolved?: number }): ILeetCodeLanguageCount => ({
            languageName: entry.languageName || "Unknown",
            problemsSolved: typeof entry.problemsSolved === "number" ? entry.problemsSolved : 0,
        }))
        .filter((entry: ILeetCodeLanguageCount) => entry.problemsSolved > 0)
        .sort((left: ILeetCodeLanguageCount, right: ILeetCodeLanguageCount) => right.problemsSolved - left.problemsSolved);

    return { languageProblemCount };
}

function mapDifficultyCounts(entries: Array<{ difficulty?: string; count?: number }>): ILeetCodeDifficultyCount[] {
    const out: ILeetCodeDifficultyCount[] = [];
    for (const entry of entries) {
        const difficulty: Difficulty | undefined = mapDifficultyLabel(entry.difficulty);
        if (!difficulty) {
            continue;
        }
        out.push({
            difficulty,
            count: typeof entry.count === "number" ? entry.count : 0,
        });
    }
    return out;
}

// Some payloads omit the "All" rollup. Synthesize one from Easy/Medium/Hard so
// the consumer can always render a "Solved X/Y" headline without conditionals.
function ensureAllAggregate(entries: ILeetCodeDifficultyCount[]): ILeetCodeDifficultyCount[] {
    if (entries.some((entry: ILeetCodeDifficultyCount) => entry.difficulty === "All")) {
        return entries;
    }

    const total: number = entries.reduce((sum: number, entry: ILeetCodeDifficultyCount) => sum + entry.count, 0);
    return [{ difficulty: "All", count: total }, ...entries];
}

function mapDifficultyLabel(value: string | undefined): Difficulty | undefined {
    switch ((value || "").toLowerCase()) {
        case "all":
            return "All";
        case "easy":
            return "Easy";
        case "medium":
            return "Medium";
        case "hard":
            return "Hard";
        default:
            return undefined;
    }
}

function mapBeatsDifficulty(value: string | undefined): "Easy" | "Medium" | "Hard" | undefined {
    switch ((value || "").toLowerCase()) {
        case "easy":
            return "Easy";
        case "medium":
            return "Medium";
        case "hard":
            return "Hard";
        default:
            return undefined;
    }
}

function normalizeTimestamp(value: string | number | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed: number = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Favorites
//
// LeetCode's favorites were migrated to "My Lists": the legacy
// addQuestionToFavorite mutation is now a no-op shim, and the problemset
// `isFavor` flag no longer tracks the default star list. The working path,
// verified live, is the *V2* mutations (favoriteSlug + questionSlug), and the
// Favorite explorer tree is driven by reading the default list's contents
// directly rather than trusting `isFavor`.
// ---------------------------------------------------------------------------

const DEFAULT_FAVORITE_NAME: string = "Favorite";
// Hard backstop for the favorite-list pagination loop (100 per page → 5,000).
const FAVORITE_LIST_MAX_PAGES: number = 50;

interface IFavoritesListsData {
    favoritesLists?: {
        allFavorites?: Array<{ idHash?: string; name?: string }>;
    };
}

interface IFavoriteQuestionListData {
    favoriteQuestionList?: {
        hasMore?: boolean;
        totalLength?: number;
        questions?: Array<{ titleSlug?: string }>;
    };
}

interface IFavoriteMutationData {
    [operationName: string]: { ok?: boolean; error?: string | null } | undefined;
}

// Resolve the slug (idHash) of the user's default "Favorite" star list — the
// same list the CLI's `star` command targeted (matched by the exact name).
export async function getDefaultFavoriteSlug(): Promise<string | undefined> {
    const cookie: string = getRequiredCookie();
    const response: IGraphqlResponse<IFavoritesListsData> = await requestJson<IGraphqlResponse<IFavoritesListsData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/`),
        data: {
            query: [
                "query favoritesList {",
                "  favoritesLists {",
                "    allFavorites {",
                "      idHash",
                "      name",
                "    }",
                "  }",
                "}",
            ].join("\n"),
            variables: {},
            operationName: "favoritesList",
        },
    }, { label: "favorites lists" });

    assertNoGraphqlErrors(response, "favorites lists");
    const all: Array<{ idHash?: string; name?: string }> = (response.data && response.data.favoritesLists && response.data.favoritesLists.allFavorites) || [];
    const match = all.find((item: { idHash?: string; name?: string }) => item.name === DEFAULT_FAVORITE_NAME);
    return match && match.idHash ? match.idHash : undefined;
}

// Returns the titleSlugs in the default "Favorite" list. The Favorite explorer
// tree reads membership from here because the problemset `isFavor` flag no
// longer reflects this list.
export async function getFavoriteProblemSlugs(): Promise<Set<string>> {
    const favoriteSlug: string | undefined = await getDefaultFavoriteSlug();
    const slugs: Set<string> = new Set<string>();
    if (!favoriteSlug) {
        return slugs;
    }

    const cookie: string = getRequiredCookie();
    let skip: number = 0;
    let hasMore: boolean = true;
    // Bound the loop: the server has been observed to ignore `limit`, so guard
    // against a `hasMore: true` + unhonored-`skip` combination spinning forever.
    for (let page: number = 0; hasMore && page < FAVORITE_LIST_MAX_PAGES; page++) {
        const response: IGraphqlResponse<IFavoriteQuestionListData> = await requestJson<IGraphqlResponse<IFavoriteQuestionListData>>({
            method: "POST",
            url: getUrl("graphql"),
            headers: createHeaders(cookie, `${getUrl("base")}/`),
            data: {
                query: [
                    "query favoriteQuestionList($favoriteSlug: String!, $limit: Int, $skip: Int) {",
                    "  favoriteQuestionList(favoriteSlug: $favoriteSlug, limit: $limit, skip: $skip) {",
                    "    hasMore",
                    "    totalLength",
                    "    questions { titleSlug }",
                    "  }",
                    "}",
                ].join("\n"),
                variables: { favoriteSlug, limit: DEFAULT_PAGE_SIZE, skip },
                operationName: "favoriteQuestionList",
            },
        }, { label: "favorite question list" });

        assertNoGraphqlErrors(response, "favorite question list");
        const list = response.data && response.data.favoriteQuestionList;
        const questions: Array<{ titleSlug?: string }> = (list && list.questions) || [];
        for (const question of questions) {
            if (question.titleSlug) {
                slugs.add(question.titleSlug);
            }
        }
        if (questions.length === 0) {
            break;
        }
        skip += questions.length;
        const total: number = (list && list.totalLength) || 0;
        hasMore = !!(list && list.hasMore) && (total <= 0 || skip < total);
    }

    return slugs;
}

export async function addFavoriteQuestion(titleSlug: string): Promise<void> {
    await mutateFavorite("addQuestionToFavoriteV2", titleSlug);
}

export async function removeFavoriteQuestion(titleSlug: string): Promise<void> {
    await mutateFavorite("removeQuestionFromFavoriteV2", titleSlug);
}

async function mutateFavorite(operationName: "addQuestionToFavoriteV2" | "removeQuestionFromFavoriteV2", titleSlug: string): Promise<void> {
    const favoriteSlug: string | undefined = await getDefaultFavoriteSlug();
    if (!favoriteSlug) {
        throw new DirectApiUnsupportedError(`Could not find your default "${DEFAULT_FAVORITE_NAME}" list on LeetCode.`, false);
    }

    const cookie: string = getRequiredCookie();
    const response: IGraphqlResponse<IFavoriteMutationData> = await requestJson<IGraphqlResponse<IFavoriteMutationData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/problems/${titleSlug}/`),
        data: {
            query: [
                `mutation ${operationName}($favoriteSlug: String!, $questionSlug: String!) {`,
                `  ${operationName}(favoriteSlug: $favoriteSlug, questionSlug: $questionSlug) {`,
                "    ok",
                "    error",
                "  }",
                "}",
            ].join("\n"),
            variables: { favoriteSlug, questionSlug: titleSlug },
            operationName,
        },
    }, { label: operationName });

    assertNoGraphqlErrors(response, operationName);
    const result = response.data && response.data[operationName];
    if (!result || !result.ok) {
        const message: string = (result && result.error) || "unknown error";
        throw new DirectApiUnsupportedError(`LeetCode rejected the favorite update: ${message}.`, false);
    }
}

// ---------------------------------------------------------------------------
// Community solutions
//
// Replaces the CLI's `show --solution`. The current "Solutions" tab is backed by
// `ugcArticleSolutionArticles` (the list) + `ugcArticleSolutionArticle` (one
// article's markdown), verified live. We fetch the most-voted article overall so
// the command matches its "Top Voted Solution" label. CN is inherited (same
// operations) but untested.
// ---------------------------------------------------------------------------

export interface ILeetCodeSolutionArticle {
    author: string;
    authorSlug: string;
    content: string;
    title: string;
    topicId: string;
    upvotes: number;
    url: string;
}

interface IUgcUser {
    userAvatar?: string;
    userName?: string;
    userSlug?: string;
}

interface ISolutionArticleNode {
    author?: IUgcUser;
    reactions?: Array<{ count?: number; reactionType?: string }>;
    slug?: string;
    title?: string;
    topicId?: number | string;
}

interface ISolutionArticlesData {
    ugcArticleSolutionArticles?: {
        edges?: Array<{ node?: ISolutionArticleNode }>;
        totalNum?: number;
    };
}

interface ISolutionArticleData {
    ugcArticleSolutionArticle?: {
        content?: string;
        slug?: string;
        title?: string;
        topicId?: number | string;
    };
}

export async function getTopSolutionArticle(titleSlug: string): Promise<ILeetCodeSolutionArticle | undefined> {
    const cookie: string = getRequiredCookie();

    const node: ISolutionArticleNode | undefined = await fetchTopSolutionNode(titleSlug, cookie);
    if (!node || node.topicId === undefined) {
        return undefined;
    }

    const topicId: string = String(node.topicId);
    const content: string = await fetchSolutionContent(topicId, cookie);
    const author: IUgcUser = node.author || {};
    return {
        author: author.userName || "Anonymous",
        authorSlug: author.userSlug || "",
        content,
        title: node.title || "Solution",
        topicId,
        upvotes: countUpvotes(node.reactions),
        url: `${getUrl("base")}/problems/${titleSlug}/solutions/${topicId}/${node.slug || ""}/`,
    };
}

async function fetchTopSolutionNode(titleSlug: string, cookie: string): Promise<ISolutionArticleNode | undefined> {
    const response: IGraphqlResponse<ISolutionArticlesData> = await requestJson<IGraphqlResponse<ISolutionArticlesData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/problems/${titleSlug}/solutions/`),
        data: {
            query: [
                "query ugcArticleSolutionArticles($questionSlug: String!, $orderBy: ArticleOrderByEnum, $skip: Int, $first: Int, $tagSlugs: [String!]) {",
                "  ugcArticleSolutionArticles(questionSlug: $questionSlug, orderBy: $orderBy, skip: $skip, first: $first, tagSlugs: $tagSlugs) {",
                "    totalNum",
                "    edges {",
                "      node {",
                "        slug",
                "        title",
                "        topicId",
                "        reactions { count reactionType }",
                "        author { userName userSlug userAvatar }",
                "      }",
                "    }",
                "  }",
                "}",
            ].join("\n"),
            // LeetCode's resolver currently errors if tagSlugs is omitted; [] is the unfiltered request.
            variables: { questionSlug: titleSlug, orderBy: "MOST_VOTES", skip: 0, first: 1, tagSlugs: [] },
            operationName: "ugcArticleSolutionArticles",
        },
    }, { label: "solution articles" });

    assertNoGraphqlErrors(response, "solution articles");
    const edges = response.data && response.data.ugcArticleSolutionArticles && response.data.ugcArticleSolutionArticles.edges;
    const first = edges && edges[0];
    return first ? first.node : undefined;
}

async function fetchSolutionContent(topicId: string, cookie: string): Promise<string> {
    const response: IGraphqlResponse<ISolutionArticleData> = await requestJson<IGraphqlResponse<ISolutionArticleData>>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, `${getUrl("base")}/`),
        data: {
            query: [
                "query ugcArticleSolutionArticle($topicId: ID!) {",
                "  ugcArticleSolutionArticle(topicId: $topicId) {",
                "    title",
                "    slug",
                "    topicId",
                "    content",
                "  }",
                "}",
            ].join("\n"),
            variables: { topicId },
            operationName: "ugcArticleSolutionArticle",
        },
    }, { label: "solution article" });

    assertNoGraphqlErrors(response, "solution article");
    const article = response.data && response.data.ugcArticleSolutionArticle;
    return (article && article.content) || "";
}

function countUpvotes(reactions: Array<{ count?: number; reactionType?: string }> | undefined): number {
    if (!reactions) {
        return 0;
    }

    const upvote = reactions.find((reaction) => reaction.reactionType === "UPVOTE");
    return (upvote && upvote.count) || 0;
}

export function mapRestProblem(raw: IRestProblemStat): ILeetCodeProblem {
    const stat = raw.stat || {};
    const totalAcs: number = stat.total_acs || 0;
    const totalSubmitted: number = stat.total_submitted || 0;
    return {
        acRate: totalSubmitted > 0 ? totalAcs * 100 / totalSubmitted : 0,
        companies: [],
        difficulty: mapRestDifficulty(raw.difficulty && raw.difficulty.level),
        isFavorite: !!raw.is_favor,
        locked: !!raw.paid_only,
        questionFrontendId: stat.frontend_question_id !== undefined && stat.frontend_question_id !== null ? String(stat.frontend_question_id) : "",
        questionId: stat.question_id !== undefined ? String(stat.question_id) : undefined,
        state: normalizeProblemState(raw.status),
        tags: [],
        title: stat.question__title || "",
        titleSlug: stat.question__title_slug || "",
    };
}

function mapRestDifficulty(level: number | undefined): "Easy" | "Medium" | "Hard" | "Unknown" {
    switch (level) {
        case 1:
            return "Easy";
        case 2:
            return "Medium";
        case 3:
            return "Hard";
        default:
            return "Unknown";
    }
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
        // Carry the internal questionId like mapGlobalProblem/mapRestProblem do, so
        // the CN path isn't silently missing it for anything keyed on the internal
        // id. (A2-10. CN remains untested overall — see audit 1 #2.)
        questionId: raw.questionId,
        state: normalizeProblemState(raw.status),
        tags: mapTags(raw.topicTags, needTranslation),
        title: (needTranslation && raw.titleCn ? raw.titleCn : raw.title) || "",
        titleSlug: raw.titleSlug || "",
    };
}

export function mapQuestionDetail(raw: IQuestionDetailItem, needTranslation: boolean): ILeetCodeQuestionDetail {
    const content: string = needTranslation && raw.translatedContent ? raw.translatedContent : raw.content || "";
    return {
        categoryTitle: raw.categoryTitle || "",
        codeSnippets: raw.codeSnippets || [],
        content,
        difficulty: normalizeDifficulty(raw.difficulty),
        dislikes: raw.dislikes || 0,
        exampleTestcaseList: raw.exampleTestcaseList || [],
        hints: raw.hints || [],
        likes: raw.likes || 0,
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
    const needTranslation: boolean = options.needTranslation !== false;
    // Fetch the first page to learn the total, then fetch the remaining pages in
    // parallel (bounded concurrency). The catalog is ~3,900 problems / ~39 pages;
    // paging it sequentially took ~20s and made search/refresh feel stuck.
    const firstPage: IProblemPage = await fetchProblemPage(categorySlug, 0, DEFAULT_PAGE_SIZE, cookie, needTranslation);
    const problems: ILeetCodeProblem[] = [...firstPage.problems];

    if (firstPage.total === undefined) {
        // No total reported: fall back to safe sequential paging.
        let skip: number = DEFAULT_PAGE_SIZE;
        let hasMore: boolean = firstPage.hasMore;
        while (hasMore) {
            const page: IProblemPage = await fetchProblemPage(categorySlug, skip, DEFAULT_PAGE_SIZE, cookie, needTranslation);
            problems.push(...page.problems);
            skip += DEFAULT_PAGE_SIZE;
            hasMore = page.hasMore;
        }
        return problems;
    }

    const skips: number[] = [];
    for (let skip: number = DEFAULT_PAGE_SIZE; skip < firstPage.total; skip += DEFAULT_PAGE_SIZE) {
        skips.push(skip);
    }
    const pages: IProblemPage[] = await mapWithConcurrency(skips, PROBLEM_LIST_CONCURRENCY,
        (skip: number) => fetchProblemPage(categorySlug, skip, DEFAULT_PAGE_SIZE, cookie, needTranslation));
    for (const page of pages) {
        problems.push(...page.problems);
    }

    return problems;
}

// Runs `fn` over `items` with at most `concurrency` in flight, preserving order.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let cursor: number = 0;
    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index: number = cursor++;
            results[index] = await fn(items[index]);
        }
    };
    const workers: Array<Promise<void>> = [];
    for (let i: number = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
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
                "      questionId",
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
