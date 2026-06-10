import { globalState } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { getUrl } from "../shared";
import { sleep } from "../utils/toolUtils";
import {
    createHeaders,
    DirectApiUnsupportedError,
    getQuestionDetail,
    ICheckResult,
    IQuestionDetail,
    ISolutionFileMeta,
    parseSolutionFile,
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

export async function testSolutionWithSyncedCookie(filePath: string, testString?: string): Promise<string> {
    const cookie: string | undefined = globalState.getCookie();
    if (!cookie) {
        throw new DirectApiUnsupportedError("No synced LeetCode cookie is available.");
    }

    const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
    const referer: string = `${getUrl("base")}/problems/${meta.slug}/`;
    const question: IQuestionDetail = await getQuestionDetail(meta.slug, cookie, referer);
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
    const task: IRunCodeTask = await runCode(meta, question, testcase, cookie, referer);
    if (!task.interpret_id) {
        throw new Error("LeetCode did not return an interpret id.");
    }

    leetCodeChannel.appendLine("Waiting for judge result");
    const actual: ICheckResult = await verifyResult(task.interpret_id, cookie, referer);
    const expected: ICheckResult | undefined = task.interpret_expected_id
        ? await verifyResult(task.interpret_expected_id, cookie, referer)
        : undefined;

    return formatTestResult(actual, expected, testcase, testcaseList);
}

async function runCode(meta: ISolutionFileMeta, question: IQuestionDetail, testcase: string, cookie: string, referer: string): Promise<IRunCodeTask> {
    const url: string = `${getUrl("base")}/problems/${meta.slug}/interpret_solution/`;
    let delaySeconds: number = 1;

    for (let attempt: number = 0; attempt < 5; attempt++) {
        const task: IRunCodeTask = await requestJson<IRunCodeTask>({
            method: "POST",
            url,
            headers: createHeaders(cookie, referer),
            data: {
                data_input: testcase,
                lang: meta.lang,
                question_id: question.questionId,
                typed_code: meta.code,
            },
        }, { label: "run-code enqueue", logMode: true });

        if (!task.error) {
            return task;
        }
        if (/session expired/i.test(task.error)) {
            leetCodeChannel.appendLine(`[test] Failure cause: LeetCode run-code response error: ${task.error}`);
            throw new DirectApiUnsupportedError("Direct LeetCode run-code request returned: session expired.", false);
        }
        if (task.error.indexOf("too soon") < 0) {
            leetCodeChannel.appendLine(`[test] Failure cause: LeetCode run-code response error: ${task.error}`);
            throw new Error(task.error);
        }

        await sleep(delaySeconds * 1000);
        delaySeconds++;
    }

    throw new Error("LeetCode rejected the run because requests were sent too quickly.");
}

function normalizeTestcase(testcase: string): string {
    return testcase.replace(/\r\n|\r/g, "\n").replace(/\\n/g, "\n").trim();
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
