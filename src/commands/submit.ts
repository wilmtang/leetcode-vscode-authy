// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeManager } from "../leetCodeManager";
import { ISubmitResume, submitSolutionWithSyncedCookie } from "../request/submit-solution";
import { promptForSignIn, reportCommandError } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";
import { judgeOperationCoordinator } from "./judgeOperationCoordinator";
import { captureAuthRequest } from "../request/authRequest";
import { runWithChallengeRecovery } from "./cloudflareRecovery";

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
        const owner = captureAuthRequest(undefined, { sameAccount: true });
        const username: string | undefined = owner.auth.identity && owner.auth.identity.username;
        if (!username) {
            await promptForSignIn();
            return;
        }
        const result: string | undefined = await runWithChallengeRecovery(
            "Submit solution",
            username,
            () => !judgeOperationCoordinator.isCurrent(operationId),
            (resume: unknown) => vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, cancellable: true },
                async (p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                    p.report({ message: resume ? "Waiting for LeetCode judge result..." : "Submitting to LeetCode..." });
                    return submitSolutionWithSyncedCookie(
                        filePath,
                        () => token.isCancellationRequested || !judgeOperationCoordinator.isCurrent(operationId),
                        resume as ISubmitResume | undefined,
                    );
                },
            ),
        );
        if (result === undefined) {
            return;
        }
        if (judgeOperationCoordinator.isCurrent(operationId)) {
            // Same-account owner: a browser sync of fresh cf_clearance/headers
            // during the run must not silently drop the result.
            owner.assertCurrent();
            leetCodeSubmissionProvider.show(result, "Submission");
        }
    } catch (error) {
        await reportCommandError("Submit solution", error, "Failed to submit the solution. Please open the output channel for details.");
        return;
    }

    leetCodeTreeDataProvider.refresh();
}
