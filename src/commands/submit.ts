// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeManager } from "../leetCodeManager";
import { ISubmitResume, submitSolutionWithSyncedCookie } from "../request/submit-solution";
import { leetCodeChannel } from "../leetCodeChannel";
import { promptForSignIn, reportCommandError } from "../utils/uiUtils";
import { getActiveFilePath } from "../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";
import { judgeOperationCoordinator, submitInFlight } from "./judgeOperationCoordinator";
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

    // Declared outside the try so the catch can tell a superseded run apart.
    let operationId: number | undefined;
    try {
        const owner = captureAuthRequest(undefined, { sameAccount: true });
        const username: string | undefined = owner.auth.identity && owner.auth.identity.username;
        if (!username) {
            await promptForSignIn();
            return;
        }
        // Refuse before begin(): begin() would supersede the running submit.
        if (!submitInFlight.tryEnter()) {
            void vscode.window.showInformationMessage("A submission is already in progress. Wait for its result, or cancel it from its notification first.");
            return;
        }
        const id: number = judgeOperationCoordinator.begin();
        operationId = id;
        let result: string | undefined;
        // Only the run itself holds the guard: it must be released before any
        // toast below is awaited, or an unanswered toast would block the next submit.
        try {
            result = await runWithChallengeRecovery(
                "Submit solution",
                username,
                () => !judgeOperationCoordinator.isCurrent(id),
                (resume: unknown) => vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, cancellable: true },
                    async (p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                        p.report({ message: resume ? "Waiting for LeetCode judge result..." : "Submitting to LeetCode..." });
                        return submitSolutionWithSyncedCookie(
                            filePath,
                            () => token.isCancellationRequested || !judgeOperationCoordinator.isCurrent(id),
                            resume as ISubmitResume | undefined,
                        );
                    },
                ),
            );
        } finally {
            submitInFlight.leave();
        }
        if (result === undefined) {
            if (!judgeOperationCoordinator.isCurrent(id)) {
                logSuperseded();
            }
            return;
        }
        if (judgeOperationCoordinator.isCurrent(id)) {
            // Same-account owner: a browser sync of fresh cf_clearance/headers
            // during the run must not silently drop the result.
            owner.assertCurrent();
            leetCodeSubmissionProvider.show(result, "Submission");
        } else {
            // The run finished, so the submission exists; only its display is dropped.
            logSuperseded();
        }
    } catch (error) {
        if (operationId !== undefined && !judgeOperationCoordinator.isCurrent(operationId)) {
            logSuperseded(error instanceof Error ? error.name : undefined);
            return;
        }
        await reportCommandError("Submit solution", error, "Failed to submit the solution. Please open the output channel for details.");
        return;
    }

    leetCodeTreeDataProvider.refresh();
}

function logSuperseded(endedWith?: string): void {
    const ended: string = endedWith ? ` (the earlier run ended with ${endedWith})` : "";
    leetCodeChannel.appendLine(`[submit] Superseded by a newer judge request${ended}; if the solution already reached LeetCode, its result is in your submission history.`);
}
