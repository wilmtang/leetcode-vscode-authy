import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import * as cp from "child_process";
import * as fse from "fs-extra";
import * as path from "path";
import { globalState, IBrowserRequestHeaders } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { getUrl } from "../shared";
import { sleep } from "../utils/toolUtils";

const MAX_VERIFY_ATTEMPTS: number = 60;
const CURL_STATUS_MARKER: string = "\n__LEETCODE_HTTP_STATUS__:";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DirectApiUnsupportedError extends Error {
    constructor(message: string, public readonly allowCliFallback: boolean = true) {
        super(message);
    }
}

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface ISolutionFileMeta {
    code: string;
    frontendId: string;
    lang: string;
    slug: string;
}

export interface IQuestionDetail {
    enableRunCode: boolean;
    exampleTestcaseList?: string[];
    exampleTestcases?: string;
    metaData?: string;
    questionFrontendId: string;
    questionId: string;
    sampleTestCase: string;
    titleSlug: string;
}

interface IQuestionDetailResponse {
    data?: {
        question?: IQuestionDetail;
    };
}

export interface ICheckResult {
    code_answer?: string | string[];
    code_output?: string | string[];
    compare_result?: string;
    compile_error?: string;
    data_input?: string | string[];
    expected_code_answer?: string | string[];
    expected_output?: string;
    full_compile_error?: string;
    full_runtime_error?: string;
    input?: string;
    lang?: string;
    last_testcase?: string;
    memory?: string;
    memory_percentile?: number;
    runtime_error?: string;
    runtime_percentile?: number;
    run_success?: boolean;
    state: string;
    status_memory?: string;
    status_msg: string;
    status_runtime?: string;
    std_output?: string;
    std_output_list?: string | string[];
    submission_id: string;
    total_correct?: number;
    total_testcases?: number;
}

export interface IRequestContext {
    label: string;
    logMode?: boolean;
}

interface ICurlResponse {
    body: string;
    status: number;
}

// ---------------------------------------------------------------------------
// Solution file parsing
// ---------------------------------------------------------------------------

export async function parseSolutionFile(filePath: string): Promise<ISolutionFileMeta> {
    const content: string = await fse.readFile(filePath, "utf8");
    const metaMatch: RegExpMatchArray | null = content.match(/@lc\s+app=\S+\s+id=(\S+)\s+lang=(\S+)/);
    if (!metaMatch) {
        throw new DirectApiUnsupportedError("Cannot find LeetCode metadata in the solution file.");
    }

    const slug: string = parseSlug(content, filePath, metaMatch[1]);
    if (!slug) {
        throw new DirectApiUnsupportedError("Cannot infer the LeetCode problem slug from the solution file.");
    }

    return {
        code: parseCode(content),
        frontendId: metaMatch[1],
        lang: metaMatch[2],
        slug,
    };
}

function parseSlug(content: string, filePath: string, frontendId: string): string {
    const linkMatch: RegExpMatchArray | null = content.match(/https:\/\/leetcode\.(?:com|cn)\/problems\/([^/\s]+)/);
    if (linkMatch) {
        return linkMatch[1];
    }

    const basename: string = path.basename(filePath);
    const parts: string[] = basename.split(".");
    if (parts.length >= 3 && parts[0] === frontendId) {
        return parts.slice(1, -1).join(".");
    }

    return "";
}

function parseCode(content: string): string {
    const lines: string[] = content.split(/\r\n|\n|\r/);
    const start: number = lines.findIndex((line: string) => line.indexOf("@lc code=start") >= 0);
    const end: number = lines.findIndex((line: string) => line.indexOf("@lc code=end") >= 0);
    if (start >= 0 && end >= 0 && start + 1 <= end) {
        return lines.slice(start + 1, end).join("\n");
    }

    return content;
}

// ---------------------------------------------------------------------------
// Question detail
// ---------------------------------------------------------------------------

export async function getQuestionDetail(slug: string, cookie: string, referer: string): Promise<IQuestionDetail> {
    const response: IQuestionDetailResponse = await requestJson<IQuestionDetailResponse>({
        method: "POST",
        url: getUrl("graphql"),
        headers: createHeaders(cookie, referer),
        data: {
            query: [
                "query getQuestionDetail($titleSlug: String!) {",
                "  question(titleSlug: $titleSlug) {",
                "    enableRunCode",
                "    exampleTestcaseList",
                "    exampleTestcases",
                "    metaData",
                "    questionFrontendId",
                "    questionId",
                "    sampleTestCase",
                "    titleSlug",
                "  }",
                "}",
            ].join("\n"),
            variables: { titleSlug: slug },
            operationName: "getQuestionDetail",
        },
    }, { label: "problem metadata" });
    const question: IQuestionDetail | undefined = response.data && response.data.question;
    if (!question) {
        throw new DirectApiUnsupportedError(`Cannot load LeetCode problem details for "${slug}".`);
    }

    return question;
}

// ---------------------------------------------------------------------------
// Result polling
// ---------------------------------------------------------------------------

export async function verifyResult(id: string, cookie: string, referer: string): Promise<ICheckResult> {
    const url: string = `${getUrl("base")}/submissions/detail/${id}/check/`;
    for (let attempt: number = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
        const result: ICheckResult = await requestJson<ICheckResult>({
            method: "GET",
            url,
            headers: createHeaders(cookie, referer),
        }, { label: "judge result poll" });
        if (result.state === "SUCCESS") {
            return result;
        }

        await sleep(1000);
    }

    throw new Error("Timed out waiting for LeetCode judge result.");
}

// ---------------------------------------------------------------------------
// HTTP request layer (axios + curl fallback)
// ---------------------------------------------------------------------------

export async function requestJson<T>(config: AxiosRequestConfig, context: IRequestContext): Promise<T> {
    if (context.logMode) {
        leetCodeChannel.appendLine(`[http] Request mode: node/axios (${context.label}).`);
    }

    let response: AxiosResponse<T>;
    try {
        response = await axios({
            ...config,
            validateStatus: () => true,
        });
    } catch (error) {
        const message: string = getErrorMessage(error);
        leetCodeChannel.appendLine(`[http] Failure cause: node/axios transport error (${context.label}): ${message}`);
        throw new Error(`node/axios request failed (${context.label}): ${message}`);
    }

    if (response.status === 401 || response.status === 403) {
        if (isCloudflareChallenge(response.data)) {
            leetCodeChannel.appendLine(`[http] Failure cause: Cloudflare challenge page from node/axios (${context.label}, HTTP ${response.status}).`);
            leetCodeChannel.appendLine(`[http] Request mode: curl (${context.label}).`);
            return requestJsonWithCurl<T>(config, context);
        }

        leetCodeChannel.appendLine(`[http] Failure cause: LeetCode rejected node/axios request (${context.label}, HTTP ${response.status}).`);
        throw new DirectApiUnsupportedError(`Direct LeetCode request was rejected by node/axios (${context.label}): HTTP ${response.status}${summarizeResponseData(response.data)}.`, false);
    }
    if (response.status !== 200) {
        leetCodeChannel.appendLine(`[http] Failure cause: unexpected node/axios HTTP status (${context.label}, HTTP ${response.status}).`);
        throw new Error(`node/axios http error (${context.label}) [code=${response.status}]`);
    }

    if (context.logMode) {
        leetCodeChannel.appendLine(`[http] node/axios request succeeded (${context.label}).`);
    }

    return response.data;
}

async function requestJsonWithCurl<T>(config: AxiosRequestConfig, context: IRequestContext): Promise<T> {
    let response: ICurlResponse;
    try {
        response = await executeCurl(config);
    } catch (error) {
        const message: string = getErrorMessage(error);
        leetCodeChannel.appendLine(`[http] Failure cause: curl transport error (${context.label}): ${message}`);
        throw new Error(`curl request failed (${context.label}): ${message}`);
    }

    if (response.status === 401 || response.status === 403) {
        if (isCloudflareChallenge(response.body)) {
            leetCodeChannel.appendLine(`[http] Failure cause: Cloudflare challenge page from curl (${context.label}, HTTP ${response.status}).`);
            throw new DirectApiUnsupportedError(`Direct LeetCode curl request hit Cloudflare challenge (${context.label}): HTTP ${response.status}${summarizeResponseData(response.body)}.`, false);
        }

        leetCodeChannel.appendLine(`[http] Failure cause: LeetCode rejected curl request (${context.label}, HTTP ${response.status}).`);
        throw new DirectApiUnsupportedError(`Direct LeetCode curl request was rejected (${context.label}): HTTP ${response.status}${summarizeResponseData(response.body)}.`, false);
    }
    if (response.status !== 200) {
        leetCodeChannel.appendLine(`[http] Failure cause: unexpected curl HTTP status (${context.label}, HTTP ${response.status}).`);
        throw new Error(`curl http error (${context.label}) [code=${response.status}]`);
    }

    try {
        const data: T = JSON.parse(response.body) as T;
        if (context.logMode) {
            leetCodeChannel.appendLine(`[http] curl request succeeded (${context.label}).`);
        }
        return data;
    } catch (error) {
        leetCodeChannel.appendLine(`[http] Failure cause: curl returned non-JSON response (${context.label}).`);
        throw new Error(`curl JSON parse failed (${context.label}). Response: ${response.body.slice(0, 200)}`);
    }
}

function executeCurl(config: AxiosRequestConfig): Promise<ICurlResponse> {
    return new Promise<ICurlResponse>((resolve: (response: ICurlResponse) => void, reject: (error: Error) => void): void => {
        const url: string | undefined = config.url;
        if (!url) {
            reject(new Error("Cannot execute curl request without a URL."));
            return;
        }

        const method: string = (config.method || "GET").toString().toUpperCase();
        const args: string[] = ["-sS", "-L", "--compressed", "-w", `${CURL_STATUS_MARKER}%{http_code}`, "-X", method, url];
        const headers: { [key: string]: unknown } = (config.headers || {}) as { [key: string]: unknown };

        for (const key of Object.keys(headers)) {
            const value: unknown = headers[key];
            if (typeof value !== "string") {
                continue;
            }

            if (key.toLowerCase() === "cookie") {
                args.push("-b", value);
            } else if (value === "") {
                args.push("-H", `${key};`);
            } else {
                args.push("-H", `${key}: ${value}`);
            }
        }

        if (config.data !== undefined && method !== "GET") {
            const body: string = typeof config.data === "string" ? config.data : JSON.stringify(config.data);
            args.push("--data-raw", body);
        }

        cp.execFile("curl", args, { maxBuffer: 10 * 1024 * 1024 }, (error: cp.ExecException | null, stdout: string, stderr: string) => {
            if (error) {
                reject(new Error(`curl request failed: ${stderr || error.message}`));
                return;
            }

            const markerIndex: number = stdout.lastIndexOf(CURL_STATUS_MARKER);
            if (markerIndex < 0) {
                reject(new Error("curl response did not include an HTTP status code."));
                return;
            }

            const body: string = stdout.slice(0, markerIndex);
            const status: number = parseInt(stdout.slice(markerIndex + CURL_STATUS_MARKER.length).trim(), 10);
            resolve({ body, status });
        });
    });
}

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

export function createHeaders(cookie: string, referer: string): { [key: string]: string } {
    const sessionCookie: string | undefined = getCookieValue(cookie, "LEETCODE_SESSION");
    const csrfToken: string | undefined = getCookieValue(cookie, "csrftoken");
    if (!sessionCookie || !csrfToken) {
        throw new DirectApiUnsupportedError("Synced cookie is missing LeetCode session data required by the judge endpoint.");
    }

    const headers: { [key: string]: string } = {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Authorization": "",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": getUrl("base"),
        "Referer": referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRFToken": csrfToken,
    };

    const browserUserAgent: string | undefined = globalState.getBrowserUserAgent();
    if (browserUserAgent) {
        headers["User-Agent"] = browserUserAgent;
    }

    const browserRequestHeaders: IBrowserRequestHeaders | undefined = globalState.getBrowserRequestHeaders();
    if (browserRequestHeaders) {
        mergeBrowserRequestHeaders(headers, browserRequestHeaders);
    }

    headers["Content-Type"] = "application/json";
    headers["Cookie"] = cookie;
    headers["Origin"] = getUrl("base");
    headers["Referer"] = referer;
    headers["X-CSRFToken"] = csrfToken;

    return headers;
}

function mergeBrowserRequestHeaders(headers: { [key: string]: string }, browserRequestHeaders: IBrowserRequestHeaders): void {
    for (const key of Object.keys(browserRequestHeaders)) {
        const canonicalKey: string | undefined = canonicalHeaderName(key);
        if (!canonicalKey) {
            continue;
        }

        headers[canonicalKey] = browserRequestHeaders[key];
    }
}

function canonicalHeaderName(name: string): string | undefined {
    const names: { [key: string]: string } = {
        "accept": "Accept",
        "accept-language": "Accept-Language",
        "authorization": "Authorization",
        "connection": "Connection",
        "dnt": "DNT",
        "priority": "Priority",
        "sec-ch-ua": "Sec-CH-UA",
        "sec-ch-ua-arch": "Sec-CH-UA-Arch",
        "sec-ch-ua-bitness": "Sec-CH-UA-Bitness",
        "sec-ch-ua-full-version": "Sec-CH-UA-Full-Version",
        "sec-ch-ua-full-version-list": "Sec-CH-UA-Full-Version-List",
        "sec-ch-ua-mobile": "Sec-CH-UA-Mobile",
        "sec-ch-ua-model": "Sec-CH-UA-Model",
        "sec-ch-ua-platform": "Sec-CH-UA-Platform",
        "sec-ch-ua-platform-version": "Sec-CH-UA-Platform-Version",
        "sec-fetch-dest": "Sec-Fetch-Dest",
        "sec-fetch-mode": "Sec-Fetch-Mode",
        "sec-fetch-site": "Sec-Fetch-Site",
        "sec-gpc": "Sec-GPC",
        "te": "TE",
        "user-agent": "User-Agent",
    };

    return names[name.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function getCookieValue(cookie: string, name: string): string | undefined {
    for (const part of cookie.split(";")) {
        const trimmed: string = part.trim();
        const separatorIndex: number = trimmed.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }
        if (trimmed.slice(0, separatorIndex) === name) {
            return trimmed.slice(separatorIndex + 1);
        }
    }

    return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isCloudflareChallenge(data: unknown): boolean {
    const text: string = typeof data === "string" ? data : JSON.stringify(data || "");
    return /<title>Just a moment\.\.\.<\/title>/i.test(text) || /cf-mitigated/i.test(text);
}

function summarizeResponseData(data: unknown): string {
    if (!data) {
        return "";
    }

    const text: string = typeof data === "string" ? data : JSON.stringify(data);
    const trimmed: string = text.replace(/\s+/g, " ").trim();
    return trimmed ? ` (${trimmed.slice(0, 200)})` : "";
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
