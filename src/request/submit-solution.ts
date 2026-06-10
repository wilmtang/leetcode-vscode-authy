import { globalState } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { getUrl } from "../shared";
import { sleep } from "../utils/toolUtils";
import {
    createHeaders,
    DirectApiUnsupportedError,
    ICheckResult,
    parseSolutionFile,
    getQuestionDetail,
    requestJson,
    verifyResult,
    ISolutionFileMeta,
    IQuestionDetail,
} from "./leetcode-http";

const MAX_SUBMIT_ATTEMPTS: number = 5;

interface ISubmitTask {
    error?: string;
    submission_id?: number;
}

export async function submitSolutionWithSyncedCookie(filePath: string): Promise<string> {
    const cookie: string | undefined = globalState.getCookie();
    if (!cookie) {
        throw new DirectApiUnsupportedError("No synced LeetCode cookie is available.");
    }

    const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
    const referer: string = `${getUrl("base")}/problems/${meta.slug}/`;
    const question: IQuestionDetail = await getQuestionDetail(meta.slug, cookie, referer);

    leetCodeChannel.appendLine("[submit] Sending solution to LeetCode");
    const task: ISubmitTask = await submitCode(meta, question, cookie, referer);
    if (!task.submission_id) {
        throw new Error("LeetCode did not return a submission id.");
    }

    leetCodeChannel.appendLine("[submit] Waiting for judge result");
    const result: ICheckResult = await verifyResult(String(task.submission_id), cookie, referer);

    return formatSubmitResult(result);
}

async function submitCode(meta: ISolutionFileMeta, question: IQuestionDetail, cookie: string, referer: string): Promise<ISubmitTask> {
    const url: string = `${getUrl("base")}/problems/${meta.slug}/submit/`;
    let delaySeconds: number = 1;

    for (let attempt: number = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
        const task: ISubmitTask = await requestJson<ISubmitTask>({
            method: "POST",
            url,
            headers: createHeaders(cookie, referer),
            data: {
                lang: meta.lang,
                question_id: question.questionId,
                typed_code: meta.code,
            },
        }, { label: "submit enqueue", logMode: true });

        if (!task.error) {
            return task;
        }
        if (/session expired/i.test(task.error)) {
            leetCodeChannel.appendLine(`[submit] Failure cause: LeetCode submit response error: ${task.error}`);
            throw new DirectApiUnsupportedError("Direct LeetCode submit request returned: session expired.", false);
        }
        if (task.error.indexOf("too soon") < 0) {
            leetCodeChannel.appendLine(`[submit] Failure cause: LeetCode submit response error: ${task.error}`);
            throw new Error(task.error);
        }

        await sleep(delaySeconds * 1000);
        delaySeconds++;
    }

    throw new Error("LeetCode rejected the submission because requests were sent too quickly.");
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
