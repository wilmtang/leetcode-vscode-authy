// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fse from "fs-extra";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import { testSolutionWithSyncedCookie } from "../request/test-solution";
import { IQuickItemEx, UserStatus } from "../shared";
import { DialogType, promptForOpenOutputChannel, showFileSelectDialog } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { decodeInlineTestcase } from "../utils/testcaseUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";
import { judgeOperationCoordinator } from "./judgeOperationCoordinator";

function runTest(filePath: string, operationId: number, testString?: string): Thenable<string> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        async (p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
            p.report({ message: "Testing on LeetCode..." });
            return testSolutionWithSyncedCookie(filePath, testString, () => token.isCancellationRequested || !judgeOperationCoordinator.isCurrent(operationId));
        },
    );
}

export async function testSolution(uri?: vscode.Uri): Promise<void> {
    try {
        if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
            await promptForOpenOutputChannel("Sign in to LeetCode before testing a solution.", DialogType.error);
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

        let result: string | undefined;
        const operationId: number = judgeOperationCoordinator.begin();
        switch (choice.value) {
            case ":default":
                result = await runTest(filePath, operationId);
                break;
            case ":direct":
                const testString: string | undefined = await vscode.window.showInputBox({
                    prompt: "Enter the test cases.",
                    validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "Test case must not be empty.",
                    placeHolder: "Example: [1,2,3]\\n4",
                    ignoreFocusOut: true,
                });
                if (testString) {
                    result = await runTest(filePath, operationId, decodeInlineTestcase(testString));
                }
                break;
            case ":file":
                const testFile: vscode.Uri[] | undefined = await showFileSelectDialog(filePath);
                if (testFile && testFile.length) {
                    const input: string = (await fse.readFile(testFile[0].fsPath, "utf-8")).trim();
                    if (input) {
                        result = await runTest(filePath, operationId, input);
                    } else {
                        vscode.window.showErrorMessage("The selected test file must not be empty.");
                    }
                }
                break;
            default:
                break;
        }
        if (!result) {
            return;
        }
        if (judgeOperationCoordinator.isCurrent(operationId)) {
            leetCodeSubmissionProvider.show(result, "Test Result");
        }
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to test the solution. Please open the output channel for details.", DialogType.error);
    }
}
