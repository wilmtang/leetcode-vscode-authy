import { globalState, UserDataType } from "../globalState";
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
// article's markdown), verified live. We fetch the most-voted article, optionally
// filtered by a language tag with an unfiltered fallback so something readable
// always renders. CN is inherited (same operations) but untested.
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

export async function getTopSolutionArticle(titleSlug: string, langSlug?: string): Promise<ILeetCodeSolutionArticle | undefined> {
    const cookie: string = getRequiredCookie();
    const tagSlugs: string[] = normalizeLanguageTags(langSlug);

    let node: ISolutionArticleNode | undefined = await fetchTopSolutionNode(titleSlug, tagSlugs, cookie);
    if (!node && tagSlugs.length > 0) {
        // No solution in the requested language — fall back to the most-voted overall.
        node = await fetchTopSolutionNode(titleSlug, [], cookie);
    }
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

async function fetchTopSolutionNode(titleSlug: string, tagSlugs: string[], cookie: string): Promise<ISolutionArticleNode | undefined> {
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
            variables: { questionSlug: titleSlug, orderBy: "MOST_VOTES", skip: 0, first: 1, tagSlugs },
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

// LeetCode tags python3 and python solutions separately; normalize so picking
// either surfaces the richer pool, matching the CLI's python3/python handling.
function normalizeLanguageTags(langSlug?: string): string[] {
    if (!langSlug) {
        return [];
    }
    if (langSlug === "python" || langSlug === "python3") {
        return ["python3", "python"];
    }

    return [langSlug];
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
