import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import * as cp from "child_process";
import * as fse from "fs-extra";
import * as path from "path";
import { globalState, IBrowserRequestHeaders } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { getUrl } from "../shared";
import { sleep } from "../utils/toolUtils";
import { classifySolutionDocument, extractSolutionCode } from "../utils/solutionDocument";

const MAX_VERIFY_ATTEMPTS: number = 60;
const CURL_STATUS_MARKER: string = "\n__LEETCODE_HTTP_STATUS__:";
// Default per-request timeout so a hung socket cannot stall a refresh (now 30+
// requests). Callers can override via the axios config's own `timeout`.
const DEFAULT_TIMEOUT_MS: number = 30000;
const MAX_COOKIE_HEADER_BYTES: number = 32 * 1024;
const MAX_REPLAYED_HEADER_BYTES: number = 8 * 1024;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DirectApiUnsupportedError extends Error {
    constructor(message: string, public readonly allowCliFallback: boolean = true) {
        super(message);
    }
}

/**
 * Cloudflare answered with an interactive challenge instead of forwarding the
 * request to LeetCode. The edge served the challenge, so the request never
 * reached the judge: re-sending the same enqueue is safe *only* in this case.
 * `resume` lets a judge workflow continue polling an already-enqueued run
 * instead of enqueueing it again.
 */
// tslint:disable-next-line:max-classes-per-file
export class CloudflareChallengeError extends DirectApiUnsupportedError {
    public resume?: unknown;
    public problemUrl?: string;

    constructor(message: string) {
        super(message, false);
        this.name = "CloudflareChallengeError";
    }
}

export function isCloudflareChallengeError(error: unknown): error is CloudflareChallengeError {
    return error instanceof CloudflareChallengeError;
}

const CHALLENGE_BACKOFF_MIN_MS: number = 4000;
const CHALLENGE_BACKOFF_JITTER_MS: number = 3000;
const MAX_POLL_CHALLENGES: number = 2;

/**
 * Challenges correlate with request bursts, so wait a few seconds (with jitter)
 * and try once more before escalating. Only a positively detected challenge is
 * retried; transport errors, timeouts and plain 5xx may have reached the origin.
 */
export async function withChallengeBackoff<T>(
    label: string,
    run: () => Promise<T>,
    isCancelled?: () => boolean,
    delayMs: number = CHALLENGE_BACKOFF_MIN_MS + Math.floor(Math.random() * CHALLENGE_BACKOFF_JITTER_MS),
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (!isCloudflareChallengeError(error)) {
            throw error;
        }
        leetCodeChannel.appendLine(`[http] Cloudflare challenge on ${label}; retrying once in ${(delayMs / 1000).toFixed(1)}s.`);
        await sleep(delayMs, isCancelled);
        throwIfCancelled(isCancelled);
        return run();
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
    isCancelled?: () => boolean;
    deadlineAt?: number;
}

export interface IHeaderOverrides {
    browserRequestHeaders?: IBrowserRequestHeaders;
    browserUserAgent?: string;
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
    const classification = classifySolutionDocument(content);
    if (!classification.frontendId || !classification.language) {
        throw new DirectApiUnsupportedError("Cannot find LeetCode metadata in the solution file.");
    }

    const slug: string = parseSlug(content, filePath, classification.frontendId);
    if (!slug) {
        throw new DirectApiUnsupportedError("Cannot infer the LeetCode problem slug from the solution file.");
    }

    return {
        code: extractSolutionCode(content),
        frontendId: classification.frontendId,
        lang: classification.language,
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

// ---------------------------------------------------------------------------
// Question detail
// ---------------------------------------------------------------------------

// Lightweight judge metadata (questionId, testcases, metaData, enableRunCode)
// for the submit/test paths. For full display detail use getQuestionDetail()
// in leetcode-api.ts instead.
export async function getQuestionDetail(slug: string, cookie: string, referer: string, overrides?: IHeaderOverrides, isCancelled?: () => boolean, graphql: string = getUrl("graphql")): Promise<IQuestionDetail> {
    const response: IQuestionDetailResponse = await requestJson<IQuestionDetailResponse>({
        method: "POST",
        url: graphql,
        headers: createHeaders(cookie, referer, overrides),
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
    }, { label: "problem metadata", isCancelled });
    throwIfCancelled(isCancelled);
    const question: IQuestionDetail | undefined = response.data && response.data.question;
    if (!question) {
        throw new DirectApiUnsupportedError(`Cannot load LeetCode problem details for "${slug}".`);
    }

    return question;
}

// ---------------------------------------------------------------------------
// Result polling
// ---------------------------------------------------------------------------

export async function verifyResult(id: string, cookie: string, referer: string, overrides?: IHeaderOverrides, isCancelled?: () => boolean, base: string = getUrl("base")): Promise<ICheckResult> {
    const url: string = `${base}/submissions/detail/${id}/check/`;
    let challenges: number = 0;
    for (let attempt: number = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
        throwIfCancelled(isCancelled);
        let result: ICheckResult;
        try {
            result = await requestJson<ICheckResult>({
                method: "GET",
                url,
                headers: createHeaders(cookie, referer, overrides),
            }, { label: "judge result poll", isCancelled });
        } catch (error) {
            // Polling is an idempotent GET: back off and keep polling the same id.
            if (!isCloudflareChallengeError(error) || ++challenges > MAX_POLL_CHALLENGES) {
                throw error;
            }
            const delayMs: number = CHALLENGE_BACKOFF_MIN_MS + Math.floor(Math.random() * CHALLENGE_BACKOFF_JITTER_MS);
            leetCodeChannel.appendLine(`[http] Cloudflare challenge on judge result poll; retrying in ${(delayMs / 1000).toFixed(1)}s.`);
            await sleep(delayMs, isCancelled);
            continue;
        }
        if (result.state === "SUCCESS") {
            return result;
        }

        await sleep(1000, isCancelled);
        throwIfCancelled(isCancelled);
    }

    throw new Error("Timed out waiting for LeetCode judge result.");
}

// ---------------------------------------------------------------------------
// HTTP request layer (axios + curl fallback)
// ---------------------------------------------------------------------------

export async function requestJson<T>(config: AxiosRequestConfig, context: IRequestContext): Promise<T> {
    const timeoutMs = typeof config.timeout === "number" && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT_MS;
    const deadlineAt = context.deadlineAt === undefined
        ? Date.now() + timeoutMs
        : context.deadlineAt;
    const cancelled = context.isCancelled;
    const assertActive = () => {
        throwIfCancelled(cancelled);
        if (Date.now() >= deadlineAt) {
            const error = new Error(`Request timed out (${context.label}).`);
            error.name = "RequestDeadlineExceededError";
            throw error;
        }
    };
    context = { ...context, deadlineAt, isCancelled: () => !!(cancelled && cancelled()) || Date.now() >= deadlineAt };
    assertActive();
    if (context.logMode) {
        leetCodeChannel.appendLine(`[http] Request mode: node/axios (${context.label}).`);
    }

    let response: AxiosResponse<T>;
    const cancelSource = context.isCancelled ? axios.CancelToken.source() : undefined;
    const cancellationTimer: NodeJS.Timer | undefined = cancelSource && context.isCancelled
        ? setInterval(() => {
            if (context.isCancelled!()) {
                cancelSource.cancel("Operation cancelled.");
            }
        }, 25)
        : undefined;
    try {
        response = await axios({
            ...config,
            timeout: Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())),
            cancelToken: cancelSource ? cancelSource.token : config.cancelToken,
            // All API URLs are already canonical. Following a redirect while
            // carrying Cookie/Authorization risks forwarding credentials to a
            // different origin.
            maxRedirects: 0,
            validateStatus: () => true,
        });
    } catch (error) {
        assertActive();
        const message: string = getErrorMessage(error);
        leetCodeChannel.appendLine(`[http] Failure cause: node/axios transport error (${context.label}): ${message}`);
        throw new Error(`node/axios request failed (${context.label}): ${message}`);
    } finally {
        if (cancellationTimer) {
            clearInterval(cancellationTimer);
        }
    }

    // Cloudflare commonly serves its "Just a moment..." challenge with 503 (and
    // occasionally 429 *or even 200*), not only 401/403. Detect it BEFORE any
    // status check — a 200 challenge would otherwise be handed back as if it were
    // real JSON and blow up downstream at parse time — so the curl fallback (which
    // replays the browser user-agent/headers) always gets a chance to pass it. (A2-9.)
    if (isCloudflareChallenge(response.data) || hasChallengeHeader(response.headers)) {
        leetCodeChannel.appendLine(`[http] Failure cause: Cloudflare challenge page from node/axios (${context.label}, HTTP ${response.status}).`);
        leetCodeChannel.appendLine(`[http] Request mode: curl (${context.label}).`);
        assertActive();
        return requestJsonWithCurl<T>({ ...config, timeout: Math.max(1, deadlineAt - Date.now()) }, context, assertActive);
    }

    if (response.status === 401 || response.status === 403) {
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

    assertActive();
    return response.data;
}

export function throwIfCancelled(isCancelled?: () => boolean): void {
    if (isCancelled && isCancelled()) {
        const error = new Error("Operation cancelled.");
        error.name = "OperationCancelledError";
        throw error;
    }
}

async function requestJsonWithCurl<T>(config: AxiosRequestConfig, context: IRequestContext, assertActive: () => void): Promise<T> {
    let response: ICurlResponse;
    try {
        response = await executeCurl(config, context.isCancelled);
    } catch (error) {
        assertActive();
        const message: string = getErrorMessage(error);
        leetCodeChannel.appendLine(`[http] Failure cause: curl transport error (${context.label}): ${message}`);
        throw new Error(`curl request failed (${context.label}): ${message}`);
    }

    // Detect the challenge before any status check: Cloudflare serves it with
    // 403, 503, 429 or even 200, and a non-403 challenge must not surface as a
    // generic HTTP error or a JSON parse failure.
    if (isCloudflareChallenge(response.body)) {
        leetCodeChannel.appendLine(`[http] Failure cause: Cloudflare challenge page from curl (${context.label}, HTTP ${response.status}).`);
        throw new CloudflareChallengeError(`Direct LeetCode curl request hit Cloudflare challenge (${context.label}): HTTP ${response.status}${summarizeResponseData(response.body)}.`);
    }
    if (response.status === 401 || response.status === 403) {
        leetCodeChannel.appendLine(`[http] Failure cause: LeetCode rejected curl request (${context.label}, HTTP ${response.status}).`);
        throw new DirectApiUnsupportedError(`Direct LeetCode curl request was rejected (${context.label}): HTTP ${response.status}${summarizeResponseData(response.body)}.`, false);
    }
    if (response.status !== 200) {
        leetCodeChannel.appendLine(`[http] Failure cause: unexpected curl HTTP status (${context.label}, HTTP ${response.status}).`);
        throw new Error(`curl http error (${context.label}) [code=${response.status}]`);
    }

    let data: T;
    try {
        data = JSON.parse(response.body) as T;
    } catch (error) {
        leetCodeChannel.appendLine(`[http] Failure cause: curl returned non-JSON response (${context.label}).`);
        throw new Error(`curl JSON parse failed (${context.label}). Response: ${response.body.slice(0, 200)}`);
    }
    assertActive();
    if (context.logMode) {
        leetCodeChannel.appendLine(`[http] curl request succeeded (${context.label}).`);
    }
    return data;
}

function executeCurl(config: AxiosRequestConfig, isCancelled?: () => boolean): Promise<ICurlResponse> {
    return new Promise<ICurlResponse>((resolve: (response: ICurlResponse) => void, reject: (error: Error) => void): void => {
        const url: string | undefined = config.url;
        if (!url) {
            reject(new Error("Cannot execute curl request without a URL."));
            return;
        }

        const method: string = (config.method || "GET").toString().toUpperCase();
        const timeoutSeconds: number = (typeof config.timeout === "number" && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT_MS) / 1000;

        // Sensitive values — the session cookie, any Authorization header, and the
        // request body — are passed through a curl config file on STDIN (`-K -`)
        // rather than argv, so they never appear in the host process list
        // (`ps aux`, `/proc/<pid>/cmdline`) where any local process could read
        // them. Only the inert `-K -` is visible on the command line. (A2-5.)
        const headers: { [key: string]: unknown } = (config.headers || {}) as { [key: string]: unknown };
        const configLines: string[] = [
            "silent",                 // -sS: quiet, but still print transport errors
            "show-error",
            "compressed",
            `max-time ${timeoutSeconds}`,
            `request ${method}`,
            `url ${curlConfigQuote(url)}`,
            // %{http_code} is emitted after the body, behind a marker we split on.
            `write-out ${curlConfigQuote(`${CURL_STATUS_MARKER}%{http_code}`)}`,
        ];

        for (const key of Object.keys(headers)) {
            const value: unknown = headers[key];
            if (typeof value !== "string") {
                continue;
            }

            if (key.toLowerCase() === "cookie") {
                configLines.push(`cookie ${curlConfigQuote(value)}`);
            } else if (value === "") {
                // Send the header present-but-empty: curl drops `Key:` but keeps `Key;`.
                configLines.push(`header ${curlConfigQuote(`${key};`)}`);
            } else {
                configLines.push(`header ${curlConfigQuote(`${key}: ${value}`)}`);
            }
        }

        if (config.data !== undefined && method !== "GET") {
            const body: string = typeof config.data === "string" ? config.data : JSON.stringify(config.data);
            configLines.push(`data-raw ${curlConfigQuote(body)}`);
        }

        let settled: boolean = false;
        let cancellationTimer: NodeJS.Timer | undefined;
        const finishError = (error: Error): void => {
            if (!settled) {
                settled = true;
                if (cancellationTimer) {
                    clearInterval(cancellationTimer);
                }
                reject(error);
            }
        };
        const finishResponse = (response: ICurlResponse): void => {
            if (!settled) {
                settled = true;
                if (cancellationTimer) {
                    clearInterval(cancellationTimer);
                }
                resolve(response);
            }
        };
        const child: cp.ChildProcess = cp.execFile("curl", ["-K", "-"], { maxBuffer: 10 * 1024 * 1024 }, (error: cp.ExecException | null, stdout: string, stderr: string) => {
            if (error) {
                finishError(new Error(`curl request failed: ${stderr || error.message}`));
                return;
            }

            const markerIndex: number = stdout.lastIndexOf(CURL_STATUS_MARKER);
            if (markerIndex < 0) {
                finishError(new Error("curl response did not include an HTTP status code."));
                return;
            }

            const body: string = stdout.slice(0, markerIndex);
            const status: number = parseInt(stdout.slice(markerIndex + CURL_STATUS_MARKER.length).trim(), 10);
            finishResponse({ body, status });
        });

        if (isCancelled) {
            cancellationTimer = setInterval(() => {
                if (isCancelled()) {
                    child.kill();
                    finishError(new Error("Operation cancelled."));
                }
            }, 25);
        }

        if (!child.stdin) {
            child.kill();
            finishError(new Error("Unable to pass the curl config on stdin."));
            return;
        }
        // If curl exits before reading all of stdin, the resulting EPIPE is benign —
        // the real outcome is reported through the execFile callback above.
        child.stdin.on("error", () => { /* ignore broken-pipe on early curl exit */ });
        child.stdin.end(`${configLines.join("\n")}\n`);
    });
}

// Quote a value for a curl `-K` config file. Inside double quotes curl honours
// backslash escapes, so backslashes and quotes must be escaped, and CR/LF are
// encoded so a header or body value can never break out onto its own config line
// (a config-injection guard). curl decodes `\n`/`\r` back to real bytes.
function curlConfigQuote(value: string): string {
    const escaped: string = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
    return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

export function createHeaders(cookie: string, referer: string, overrides?: IHeaderOverrides): { [key: string]: string } {
    if (!isSafeHeaderValue(cookie, MAX_COOKIE_HEADER_BYTES)) {
        throw new DirectApiUnsupportedError("Synced cookie contains invalid or excessive header data.");
    }
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

    const browserUserAgent: string | undefined = overrides
        ? overrides.browserUserAgent
        : globalState.getBrowserUserAgent();
    if (browserUserAgent && isSafeHeaderValue(browserUserAgent, MAX_REPLAYED_HEADER_BYTES)) {
        headers["User-Agent"] = browserUserAgent;
    }

    const browserRequestHeaders: IBrowserRequestHeaders | undefined = overrides
        ? overrides.browserRequestHeaders
        : globalState.getBrowserRequestHeaders();
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

        const value: string = browserRequestHeaders[key];
        if (isSafeHeaderValue(value, MAX_REPLAYED_HEADER_BYTES)) {
            headers[canonicalKey] = value;
        }
    }
}

function canonicalHeaderName(name: string): string | undefined {
    const names: { [key: string]: string } = {
        "accept": "Accept",
        "accept-language": "Accept-Language",
        "authorization": "Authorization",
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

function hasChallengeHeader(headers: unknown): boolean {
    if (!headers || typeof headers !== "object") {
        return false;
    }
    const value: unknown = (headers as { [key: string]: unknown })["cf-mitigated"];
    return typeof value === "string" && /challenge/i.test(value);
}

// Only an HTML body can be a challenge page. Parsed or parseable JSON is a real
// LeetCode response even if it echoes user input such as a custom test case
// containing the challenge title; misclassifying it would re-send a run that
// already reached the judge. The canonical signal is the cf-mitigated header.
function isCloudflareChallenge(data: unknown): boolean {
    if (typeof data !== "string") {
        return false;
    }
    const trimmed: string = data.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            JSON.parse(trimmed);
            return false;
        } catch (error) {
            // Not JSON; fall through to the HTML check.
        }
    }
    return /<title>Just a moment\.\.\.<\/title>/i.test(trimmed);
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

function isSafeHeaderValue(value: string, maxBytes: number): boolean {
    return !/[\0\r\n]/.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}
