// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeManager } from "../leetCodeManager";
import { submitSolutionWithSyncedCookie } from "../request/submit-solution";
import { DialogType, promptForOpenOutputChannel, promptForSignIn } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";

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
        const result: string = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification },
            async (p: vscode.Progress<{ message?: string }>) => {
                p.report({ message: "Submitting to LeetCode..." });
                return submitSolutionWithSyncedCookie(filePath);
            },
        );
        leetCodeSubmissionProvider.show(result);
    } catch (error) {
        await promptForOpenOutputChannel("Failed to submit the solution. Please open the output channel for details.", DialogType.error);
        return;
    }

    leetCodeTreeDataProvider.refresh();
}
