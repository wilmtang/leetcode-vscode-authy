import * as assert from "assert";
import * as vscode from "vscode";
import { submitInFlight } from "../../commands/judgeOperationCoordinator";
import { submitSolution } from "../../commands/submit";
import { leetCodeTreeDataProvider } from "../../explorer/LeetCodeTreeDataProvider";
import { leetCodeManager } from "../../leetCodeManager";
import * as authRequest from "../../request/authRequest";
import * as submitRequest from "../../request/submit-solution";
import * as workspaceUtils from "../../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../../webview/leetCodeSubmissionProvider";

interface IRun {
    isCancelled: () => boolean;
    resolve: (result: string) => void;
    reject: (error: Error) => void;
}

// Drives the real submitSolution command with the network, editor and webview
// stubbed, so the guard's placement relative to begin() and toasts is pinned.
describe("submit in-flight guard wiring", () => {
    const restore: Array<() => void> = [];
    let runs: IRun[];
    let infos: string[];
    let errorToasts: number;
    let shown: string[];

    function stub<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
        const original: T[K] = target[key];
        (target as { [key: string]: unknown })[key as string] = value;
        restore.push(() => { target[key] = original; });
    }

    beforeEach(() => {
        runs = [];
        infos = [];
        errorToasts = 0;
        shown = [];
        stub(leetCodeManager, "getUser", () => "user");
        stub(workspaceUtils, "getActiveFilePath", () => Promise.resolve("/tmp/1.two-sum.ts"));
        stub(authRequest, "captureAuthRequest", () => ({ auth: { identity: { username: "user" } }, assertCurrent: () => undefined }));
        stub(submitRequest, "submitSolutionWithSyncedCookie", (_file: string, isCancelled: () => boolean) =>
            new Promise<string>((resolve, reject) => runs.push({ isCancelled, resolve, reject })));
        stub(leetCodeSubmissionProvider, "show", (result: string) => { shown.push(result); });
        stub(leetCodeTreeDataProvider, "refresh", () => undefined);
        stub(vscode.window, "withProgress", (_options: unknown, task: (p: unknown, token: unknown) => unknown) =>
            task({ report: () => undefined }, { isCancellationRequested: false }));
        stub(vscode.window, "showInformationMessage", (message: string) => { infos.push(message); return Promise.resolve(undefined); });
        // An error toast the user never answers.
        stub(vscode.window, "showErrorMessage", () => { errorToasts++; return new Promise<undefined>(() => undefined); });
    });

    afterEach(() => {
        while (restore.length) {
            restore.pop()!();
        }
        // The guard is module state: a test that fails mid-run must not leave
        // it held and fail the next test for an unrelated reason.
        submitInFlight.leave();
    });

    it("refuses a second submit without cancelling the first, then admits the next one", async () => {
        const first: Promise<void> = submitSolution();
        await waitFor(() => runs.length === 1, "first submit to start");

        await submitSolution();
        assert.strictEqual(runs.length, 1, "the second submit must not be sent");
        assert.strictEqual(infos.length, 1);
        assert.ok(/already in progress/.test(infos[0]), infos[0]);
        assert.ok(!runs[0].isCancelled(), "the second submit must not supersede the first");

        runs[0].resolve("Accepted");
        await first;
        assert.deepStrictEqual(shown, ["Accepted"]);

        const third: Promise<void> = submitSolution();
        await waitFor(() => runs.length === 2, "a submit after the first finished to start");
        runs[1].resolve("Accepted again");
        await third;
    });

    it("frees the slot before an unanswered error toast", async () => {
        const failed: Promise<void> = submitSolution();
        await waitFor(() => runs.length === 1, "first submit to start");
        runs[0].reject(new Error("boom"));
        await waitFor(() => errorToasts === 1, "the error toast");

        const next: Promise<void> = submitSolution();
        await waitFor(() => runs.length === 2, "a new submit while the error toast is still open");
        runs[1].resolve("Accepted");
        await next;
        void failed;
    });
});

async function waitFor(condition: () => boolean, what: string, timeoutMs: number = 2000): Promise<void> {
    const deadline: number = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}.`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}
