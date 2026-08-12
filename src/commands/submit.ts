// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeManager } from "../leetCodeManager";
import { submitSolutionWithSyncedCookie } from "../request/submit-solution";
import { DialogType, promptForOpenOutputChannel, promptForSignIn } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";
import { judgeOperationCoordinator } from "./judgeOperationCoordinator";

export async function submitSolution(uri?: vscode.Uri): Promise<void> {
    if (!leetCodeManager.getUser()) {
        promptForSignIn();
        return;
    }

    const filePath: string | undefined = await getActiveFilePath(uri);
    if (!filePath) {
        return;
    }

    try {
        const operationId: number = judgeOperationCoordinator.begin();
        const result: string = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, cancellable: true },
            async (p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                p.report({ message: "Submitting to LeetCode..." });
                return submitSolutionWithSyncedCookie(filePath, () => token.isCancellationRequested || !judgeOperationCoordinator.isCurrent(operationId));
            },
        );
        if (judgeOperationCoordinator.isCurrent(operationId)) {
            leetCodeSubmissionProvider.show(result, "Submission");
        }
    } catch (error) {
        await promptForOpenOutputChannel("Failed to submit the solution. Please open the output channel for details.", DialogType.error);
        return;
    }

    leetCodeTreeDataProvider.refresh();
}
