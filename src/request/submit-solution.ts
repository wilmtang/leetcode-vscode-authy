import { IAuthSessionSnapshot } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { captureAuthRequest, isSameAccountCurrent } from "./authRequest";
import {
    createHeaders,
    isCloudflareChallengeError,
    isRateLimitedError,
    RateLimitedError,
    enqueueWithBackoff,
    withChallengeBackoff,
    DirectApiUnsupportedError,
    ICheckResult,
    parseSolutionFile,
    getQuestionDetail,
    requestJson,
    verifyResult,
    ISolutionFileMeta,
    IQuestionDetail,
    IHeaderOverrides,
} from "./leetcode-http";

interface ISubmitTask {
    error?: string;
    submission_id?: number;
}

/** State for resuming a submission whose enqueue already succeeded. */
export interface ISubmitResume {
    kind: "submit";
    filePath: string;
    submissionId: string;
}

export async function submitSolutionWithSyncedCookie(filePath: string, isCancelled?: () => boolean, resume?: ISubmitResume): Promise<string> {
    const owner = captureAuthRequest(isCancelled, { sameAccount: true });
    owner.assertCurrent();
    isCancelled = owner.isCancelled;
    const auth = owner.auth;
    const cookie: string = owner.cookie;
    const headerOverrides: IHeaderOverrides = {
        browserUserAgent: auth.browserUserAgent,
        browserRequestHeaders: auth.browserRequestHeaders,
    };

    const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
    const referer: string = `${owner.base}/problems/${meta.slug}/`;
    const tagChallenge = (error: unknown, pending?: ISubmitResume): unknown => {
        if (isCloudflareChallengeError(error)) {
            error.problemUrl = referer;
            error.resume = pending;
        }
        return error;
    };

    let submissionId: string;
    if (resume && resume.kind === "submit" && resume.filePath === filePath) {
        // The enqueue already reached the judge; never enqueue it again.
        submissionId = resume.submissionId;
        leetCodeChannel.appendLine(`[submit] Resuming judge result polling for submission ${submissionId}`);
    } else {
        let task: ISubmitTask;
        try {
            const question: IQuestionDetail = await withChallengeBackoff("problem metadata",
                () => getQuestionDetail(meta.slug, cookie, referer, headerOverrides, isCancelled, owner.graphql), isCancelled);
            assertCurrentAuth(auth);
            leetCodeChannel.appendLine("[submit] Sending solution to LeetCode");
            task = await submitCode(meta, question, cookie, referer, headerOverrides, auth, isCancelled);
        } catch (error) {
            throw tagChallenge(error);
        }
        if (!task.submission_id) {
            throw new Error("LeetCode did not return a submission id.");
        }
        submissionId = String(task.submission_id);
    }

    leetCodeChannel.appendLine("[submit] Waiting for judge result");
    let result: ICheckResult;
    try {
        result = await verifyResult(submissionId, cookie, referer, headerOverrides, isCancelled, owner.base);
    } catch (error) {
        if (isCloudflareChallengeError(error)) {
            leetCodeChannel.appendLine(`[submit] Submission ${submissionId} was accepted by LeetCode, but its result could not be read.`);
        }
        if (isRateLimitedError(error)) {
            leetCodeChannel.appendLine(`[submit] Submission ${submissionId} was accepted by LeetCode, but the result check was rate limited.`);
            throw new RateLimitedError(error.label, "LeetCode rate-limited the result check. Your submission was already sent; check its result on LeetCode before submitting again.");
        }
        throw tagChallenge(error, { kind: "submit", filePath, submissionId });
    }
    owner.assertCurrent();

    return formatSubmitResult(result);
}

async function submitCode(
    meta: ISolutionFileMeta,
    question: IQuestionDetail,
    cookie: string,
    referer: string,
    headerOverrides: IHeaderOverrides,
    auth: IAuthSessionSnapshot,
    isCancelled?: () => boolean,
): Promise<ISubmitTask> {
    const url: string = `${new URL(referer).origin}/problems/${meta.slug}/submit/`;
    // Re-sent only when the submission provably never reached the judge: a
    // detected Cloudflare challenge (withChallengeBackoff), or LeetCode refusing
    // it as too soon / HTTP 429 (enqueueWithBackoff).
    const task: ISubmitTask = await enqueueWithBackoff("submit enqueue", "submit", () => {
        assertCurrentAuth(auth);
        return withChallengeBackoff("submit enqueue", () => requestJson<ISubmitTask>({
            method: "POST",
            url,
            headers: createHeaders(cookie, referer, headerOverrides),
            data: {
                lang: meta.lang,
                question_id: question.questionId,
                typed_code: meta.code,
            },
        }, { label: "submit enqueue", logMode: true, isCancelled }), isCancelled);
    }, isCancelled);

    if (!task.error) {
        return task;
    }
    leetCodeChannel.appendLine(`[submit] Failure cause: LeetCode submit response error: ${task.error}`);
    if (/session expired/i.test(task.error)) {
        throw new DirectApiUnsupportedError("Direct LeetCode submit request returned: session expired.", false);
    }
    throw new Error(task.error);
}

function assertCurrentAuth(auth: IAuthSessionSnapshot): void {
    if (!isSameAccountCurrent(auth)) {
        throw new DirectApiUnsupportedError("The signed-in LeetCode account changed before this submission could be sent.", false);
    }
}

function formatSubmitResult(result: ICheckResult): string {
    const errors: string[] = collectErrors(result);
    const ok: boolean = !!result.run_success && result.status_msg === "Accepted" && errors.length === 0;
    const lines: string[] = [];

    appendLine(lines, ok, result.status_msg);
    for (const error of errors) {
        appendKeyValue(lines, ok, "Error", error);
    }

    if (result.status_runtime) {
        appendKeyValue(lines, ok, "Runtime", result.status_runtime);
    }
    if (result.status_memory) {
        appendKeyValue(lines, ok, "Memory", result.status_memory);
    }
    if (result.total_correct !== undefined && result.total_testcases !== undefined) {
        appendKeyValue(lines, ok, "Test Cases", `${result.total_correct}/${result.total_testcases} passed`);
    }
    if (result.runtime_percentile !== undefined && result.runtime_percentile > 0) {
        appendKeyValue(lines, ok, "Runtime Beats", `${result.runtime_percentile.toFixed(2)}%`);
    }
    if (result.memory_percentile !== undefined && result.memory_percentile > 0) {
        appendKeyValue(lines, ok, "Memory Beats", `${result.memory_percentile.toFixed(2)}%`);
    }
    if (!ok && result.last_testcase) {
        appendKeyValue(lines, ok, "Last Testcase", result.last_testcase);
    }
    if (!ok && result.expected_output) {
        appendKeyValue(lines, ok, "Expected Answer", result.expected_output);
    }
    if (!ok) {
        const output: string = Array.isArray(result.code_output)
            ? result.code_output.join("\n")
            : (result.code_output || "");
        if (output) {
            appendKeyValue(lines, ok, "Your Output", output);
        }
    }

    return lines.join("\n") + "\n";
}

function collectErrors(result: ICheckResult): string[] {
    const errors: string[] = [];
    for (const key of Object.keys(result)) {
        if (/_error$/.test(key)) {
            const value: unknown = (result as unknown as { [key: string]: unknown })[key];
            if (typeof value === "string" && value.length > 0) {
                errors.push(value);
            }
        }
    }

    return errors;
}

function appendKeyValue(lines: string[], ok: boolean, key: string, value: string): void {
    appendLine(lines, ok, `${key}: ${value}`);
}

function appendLine(lines: string[], ok: boolean, value: string): void {
    lines.push(`  ${ok ? "✔" : "✘"} ${value}`);
}
