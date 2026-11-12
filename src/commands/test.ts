// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fse from "fs-extra";
import * as vscode from "vscode";
import { leetCodeManager } from "../leetCodeManager";
import { ITestResume, testSolutionWithSyncedCookie } from "../request/test-solution";
import { IQuickItemEx, UserStatus } from "../shared";
import { promptForSignIn, reportCommandError, showFileSelectDialog } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { decodeInlineTestcase } from "../utils/testcaseUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";
import { judgeOperationCoordinator } from "./judgeOperationCoordinator";
import { captureAuthRequest } from "../request/authRequest";
import { runWithChallengeRecovery } from "./cloudflareRecovery";

function runTest(filePath: string, operationId: number, username: string, testString?: string): Promise<string | undefined> {
    return runWithChallengeRecovery(
        "Test solution",
        username,
        () => !judgeOperationCoordinator.isCurrent(operationId),
        (resume: unknown) => vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, cancellable: true },
            async (p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                p.report({ message: resume ? "Waiting for LeetCode judge result..." : "Testing on LeetCode..." });
                return testSolutionWithSyncedCookie(
                    filePath,
                    testString,
                    () => token.isCancellationRequested || !judgeOperationCoordinator.isCurrent(operationId),
                    resume as ITestResume | undefined,
                );
            },
        ),
    );
}

export async function testSolution(uri?: vscode.Uri): Promise<void> {
    try {
        if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
            await promptForSignIn();
            return;
        }

        const filePath: string | undefined = await getActiveFilePath(uri);
        if (!filePath) {
            return;
        }
        const picks: Array<IQuickItemEx<string>> = [];
        picks.push(
            {
                label: "$(three-bars) Default test cases",
                description: "",
                detail: "Test with the default cases",
                value: ":default",
            },
            {
                label: "$(pencil) Write directly...",
                description: "",
                detail: "Write test cases in input box",
                value: ":direct",
            },
            {
                label: "$(file-text) Browse...",
                description: "",
                detail: "Test with the written cases in file",
                value: ":file",
            },
        );
        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks);
        if (!choice) {
            return;
        }

        const owner = captureAuthRequest(undefined, { sameAccount: true });
        const username: string | undefined = owner.auth.identity && owner.auth.identity.username;
        if (!username) {
            await promptForSignIn();
            return;
        }
        // Collect the test input before begin(): begin() supersedes a running
        // submit, and a test the user then abandons must not cost them that.
        let testString: string | undefined;
        switch (choice.value) {
            case ":default":
                break;
            case ":direct":
                const typed: string | undefined = await vscode.window.showInputBox({
                    prompt: "Enter the test cases.",
                    validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "Test case must not be empty.",
                    placeHolder: "Example: [1,2,3]\\n4",
                    ignoreFocusOut: true,
                });
                if (!typed) {
                    return;
                }
                testString = decodeInlineTestcase(typed);
                break;
            case ":file":
                const testFile: vscode.Uri[] | undefined = await showFileSelectDialog(filePath);
                if (!testFile || !testFile.length) {
                    return;
                }
                testString = (await fse.readFile(testFile[0].fsPath, "utf-8")).trim();
                if (!testString) {
                    vscode.window.showErrorMessage("The selected test file must not be empty.");
                    return;
                }
                break;
            default:
                return;
        }
        const operationId: number = judgeOperationCoordinator.begin();
        const result: string | undefined = await runTest(filePath, operationId, username, testString);
        if (!result) {
            return;
        }
        if (judgeOperationCoordinator.isCurrent(operationId)) {
            // Same-account owner: a browser sync of fresh cf_clearance/headers
            // during the run must not silently drop the result.
            owner.assertCurrent();
            leetCodeSubmissionProvider.show(result, "Test Result");
        }
    } catch (error) {
        await reportCommandError("Test solution", error, "Failed to test the solution. Please open the output channel for details.");
    }
}
