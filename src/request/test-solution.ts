import { IAuthSessionSnapshot } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { captureAuthRequest, isSameAccountCurrent } from "./authRequest";
import { normalizeTestcase } from "../utils/testcaseUtils";
import {
    createHeaders,
    DirectApiUnsupportedError,
    isCloudflareChallengeError,
    enqueueWithBackoff,
    withChallengeBackoff,
    getQuestionDetail,
    ICheckResult,
    IQuestionDetail,
    IHeaderOverrides,
    ISolutionFileMeta,
    parseSolutionFile,
    isRateLimitedError,
    RateLimitedError,
    requestJson,
    verifyResult,
} from "./leetcode-http";

// Re-export for backward compatibility with any other importers.
export { DirectApiUnsupportedError } from "./leetcode-http";

interface IRunCodeTask {
    error?: string;
    interpret_expected_id?: string;
    interpret_id?: string;
}

interface IQuestionMetaData {
    params?: unknown[];
    systemdesign?: boolean;
}

interface ICaseResult {
    accepted: boolean;
    expected: string;
    input: string;
    output: string;
    status: string;
    stdout: string;
}

/** State for resuming a test run whose enqueue already succeeded. */
export interface ITestResume {
    kind: "test";
    filePath: string;
    testcase: string;
    testcaseList: string[];
    interpretId: string;
    interpretExpectedId?: string;
}

export async function testSolutionWithSyncedCookie(filePath: string, testString?: string, isCancelled?: () => boolean, resume?: ITestResume): Promise<string> {
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
    const tagChallenge = (error: unknown, resumable?: ITestResume): unknown => {
        if (isCloudflareChallengeError(error)) {
            error.problemUrl = referer;
            error.resume = resumable;
        }
        return error;
    };

    let pending: ITestResume;
    if (resume && resume.kind === "test" && resume.filePath === filePath) {
        // The run was already enqueued; poll the same ids instead of re-running it.
        pending = resume;
        leetCodeChannel.appendLine("[test] Resuming judge result polling");
    } else {
        try {
            const question: IQuestionDetail = await withChallengeBackoff("problem metadata",
                () => getQuestionDetail(meta.slug, cookie, referer, headerOverrides, isCancelled, owner.graphql), isCancelled);
            const defaultTestcases: string[] = getDefaultTestcases(question);
            const testcase: string = normalizeTestcase(testString || defaultTestcases.join("\n"));
            const testcaseList: string[] = testString ? splitTestcases(testcase, question) : defaultTestcases;

            if (!question.enableRunCode) {
                throw new Error("not testable? please submit directly!");
            }
            if (!testcase) {
                throw new Error("missing testcase?");
            }

            leetCodeChannel.appendLine("Sending code to judge");
            assertCurrentAuth(auth);
            const task: IRunCodeTask = await runCode(meta, question, testcase, cookie, referer, headerOverrides, auth, isCancelled);
            if (!task.interpret_id) {
                throw new Error("LeetCode did not return an interpret id.");
            }
            pending = {
                kind: "test",
                filePath,
                testcase,
                testcaseList,
                interpretId: task.interpret_id,
                interpretExpectedId: task.interpret_expected_id,
            };
        } catch (error) {
            throw tagChallenge(error);
        }
    }

    leetCodeChannel.appendLine("Waiting for judge result");
    let actual: ICheckResult;
    let expected: ICheckResult | undefined;
    try {
        actual = await verifyResult(pending.interpretId, cookie, referer, headerOverrides, isCancelled, owner.base);
        expected = pending.interpretExpectedId
            ? await verifyResult(pending.interpretExpectedId, cookie, referer, headerOverrides, isCancelled, owner.base)
            : undefined;
    } catch (error) {
        if (isRateLimitedError(error)) {
            leetCodeChannel.appendLine("[test] The test run was sent, but the result check was rate limited.");
            throw new RateLimitedError(error.label, "LeetCode rate-limited the result check. Your test run was sent; try again in a moment.");
        }
        throw tagChallenge(error, pending);
    }

    owner.assertCurrent();
    return formatTestResult(actual, expected, pending.testcase, pending.testcaseList);
}

async function runCode(
    meta: ISolutionFileMeta,
    question: IQuestionDetail,
    testcase: string,
    cookie: string,
    referer: string,
    headerOverrides: IHeaderOverrides,
    auth: IAuthSessionSnapshot,
    isCancelled?: () => boolean,
): Promise<IRunCodeTask> {
    const url: string = `${new URL(referer).origin}/problems/${meta.slug}/interpret_solution/`;
    // Re-sent only when the run provably never reached the judge: a detected
    // Cloudflare challenge (withChallengeBackoff), or LeetCode refusing it as
    // too soon / HTTP 429 (enqueueWithBackoff).
    const task: IRunCodeTask = await enqueueWithBackoff("run-code enqueue", "test", () => {
        assertCurrentAuth(auth);
        return withChallengeBackoff("run-code enqueue", () => requestJson<IRunCodeTask>({
            method: "POST",
            url,
            headers: createHeaders(cookie, referer, headerOverrides),
            data: {
                data_input: testcase,
                lang: meta.lang,
                question_id: question.questionId,
                typed_code: meta.code,
            },
        }, { label: "run-code enqueue", logMode: true, isCancelled }), isCancelled);
    }, isCancelled);

    if (!task.error) {
        return task;
    }
    leetCodeChannel.appendLine(`[test] Failure cause: LeetCode run-code response error: ${task.error}`);
    if (/session expired/i.test(task.error)) {
        throw new DirectApiUnsupportedError("Direct LeetCode run-code request returned: session expired.", false);
    }
    throw new Error(task.error);
}

function assertCurrentAuth(auth: IAuthSessionSnapshot): void {
    if (!isSameAccountCurrent(auth)) {
        throw new DirectApiUnsupportedError("The signed-in LeetCode account changed before this test could be sent.", false);
    }
}

function getDefaultTestcases(question: IQuestionDetail): string[] {
    if (question.exampleTestcaseList && question.exampleTestcaseList.length > 0) {
        const testcases: string[] = question.exampleTestcaseList.map(normalizeTestcase).filter((value: string) => !!value);
        if (testcases.length > 0) {
            return testcases;
        }
    }

    const source: string = question.exampleTestcases || question.sampleTestCase;
    return splitTestcases(source, question);
}

function splitTestcases(testcase: string | string[] | undefined, question: IQuestionDetail): string[] {
    if (Array.isArray(testcase)) {
        return testcase.map(normalizeTestcase).filter((value: string) => !!value);
    }
    if (!testcase) {
        return [];
    }

    const normalized: string = normalizeTestcase(testcase);
    if (!normalized) {
        return [];
    }

    const inputCount: number = getTestcaseInputCount(question);
    const lines: string[] = normalized.split("\n");
    if (inputCount <= 0 || lines.length <= inputCount || lines.length % inputCount !== 0) {
        return [normalized];
    }

    const testcases: string[] = [];
    for (let index: number = 0; index < lines.length; index += inputCount) {
        testcases.push(lines.slice(index, index + inputCount).join("\n"));
    }

    return testcases.filter((value: string) => !!value.trim());
}

function getTestcaseInputCount(question: IQuestionDetail): number {
    const metaData: IQuestionMetaData = parseQuestionMetaData(question.metaData);
    if (metaData.systemdesign) {
        return 2;
    }
    if (metaData.params && metaData.params.length > 0) {
        return metaData.params.length;
    }

    return 1;
}

function parseQuestionMetaData(metaData: string | undefined): IQuestionMetaData {
    if (!metaData) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(metaData);
        if (parsed && typeof parsed === "object") {
            return parsed as IQuestionMetaData;
        }
    } catch (error) {
        // LeetCode still provides sampleTestCase as a fallback when metadata is malformed.
    }

    return {};
}

function formatTestResult(actual: ICheckResult, expected: ICheckResult | undefined, testcase: string, testcaseList: string[]): string {
    const errors: string[] = collectErrors(actual);
    const passed: number = actual.total_correct || 0;
    const total: number = actual.total_testcases || 0;
    const ok: boolean = !!actual.run_success && passed === total && actual.status_msg === "Accepted" && errors.length === 0;
    const state: string = actual.status_msg === "Accepted" ? "Finished" : actual.status_msg;
    const cases: ICaseResult[] = buildCaseResults(actual, expected, testcase, testcaseList, ok);
    const lines: string[] = [];

    appendLine(lines, ok, state);
    for (const error of errors) {
        appendKeyValue(lines, ok, "Error", error);
    }
    for (let index: number = 0; index < cases.length; index++) {
        const result: ICaseResult = cases[index];
        appendKeyValue(lines, result.accepted, `Case ${index + 1} (${result.status})`, formatCaseResult(result));
    }

    return lines.join("\n") + "\n";
}

function buildCaseResults(actual: ICheckResult, expected: ICheckResult | undefined, testcase: string, testcaseList: string[], allAccepted: boolean): ICaseResult[] {
    const inputs: string[] = testcaseList.length > 0 ? testcaseList : arrayFromValue(actual.data_input);
    const normalizedInputs: string[] = inputs.length > 0 ? inputs : [testcase];
    const outputs: string[] = arrayFromValue(actual.code_answer);
    const expectedAnswers: string[] = expected ? arrayFromValue(expected.code_answer) : arrayFromValue(actual.expected_code_answer || actual.expected_output);
    const stdout: string[] = arrayFromValue(actual.std_output_list || actual.code_output || actual.std_output);
    const compareResult: string = actual.compare_result || "";
    const resultCount: number = getDisplayCaseCount(actual, normalizedInputs, outputs, expectedAnswers, stdout, compareResult);
    const cases: ICaseResult[] = [];

    for (let index: number = 0; index < resultCount; index++) {
        const accepted: boolean = isCaseAccepted(index, allAccepted, actual, normalizedInputs, compareResult);
        cases.push({
            accepted,
            expected: normalizeResultValue(expectedAnswers[index] || ""),
            input: normalizeResultValue(normalizedInputs[index] || ""),
            output: normalizeResultValue(outputs[index] || ""),
            status: accepted ? "Accepted" : getFailedCaseStatus(actual),
            stdout: normalizeResultValue(stdout[index] || ""),
        });
    }

    return cases;
}

function getDisplayCaseCount(
    actual: ICheckResult,
    inputs: string[],
    outputs: string[],
    expectedAnswers: string[],
    stdout: string[],
    compareResult: string,
): number {
    if (actual.total_testcases && actual.total_testcases > 0) {
        return actual.total_testcases;
    }
    if (compareResult.length > 0) {
        return compareResult.length;
    }
    if (inputs.length > 0) {
        return inputs.length;
    }

    return Math.max(
        countNonEmptyPrefix(outputs),
        countNonEmptyPrefix(expectedAnswers),
        countNonEmptyPrefix(stdout),
    );
}

function countNonEmptyPrefix(values: string[]): number {
    for (let index: number = values.length - 1; index >= 0; index--) {
        if (values[index]) {
            return index + 1;
        }
    }

    return 0;
}

function isCaseAccepted(index: number, allAccepted: boolean, actual: ICheckResult, inputs: string[], compareResult: string): boolean {
    if (index < compareResult.length) {
        return compareResult.charAt(index) === "1";
    }
    if (allAccepted) {
        return true;
    }

    const total: number | undefined = actual.total_testcases;
    const passed: number | undefined = actual.total_correct;
    if (total !== undefined && passed !== undefined && total === inputs.length) {
        return index < passed;
    }

    const lastTestcase: string = normalizeTestcase(actual.last_testcase || "");
    if (lastTestcase && normalizeTestcase(inputs[index] || "") === lastTestcase) {
        return false;
    }

    return false;
}

function getFailedCaseStatus(actual: ICheckResult): string {
    if (actual.status_msg && actual.status_msg !== "Accepted") {
        return actual.status_msg;
    }

    return "Wrong Answer";
}

function formatCaseResult(result: ICaseResult): string {
    const lines: string[] = [`Status: ${result.status}`];
    appendCaseField(lines, "Input", result.input);
    appendCaseField(lines, "Output", result.output);
    appendCaseField(lines, "Expected Answer", result.expected);
    appendCaseField(lines, "Stdout", result.stdout);
    return lines.join("\n");
}

function appendCaseField(lines: string[], key: string, value: string): void {
    if (!value) {
        return;
    }

    lines.push(`${key}:`);
    lines.push(value);
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

function arrayFromValue(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) {
        return value.map(normalizeResultValue);
    }
    if (!value) {
        return [];
    }

    return [normalizeResultValue(value)];
}

function normalizeResultValue(value: string): string {
    return value.replace(/\\n/g, "\n");
}
