// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { globalState } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { CloudflareChallengeError, getCookieValue, isCloudflareChallengeError } from "../request/leetcode-http";
import { openUrl } from "../utils/uiUtils";

const CLEARANCE_WAIT_MS: number = 3 * 60 * 1000;
const CLEARANCE_POLL_MS: number = 500;
const OPEN_IN_BROWSER: string = "Open in Browser";

export type ClearanceOutcome = "synced" | "cancelled" | "timeout" | "superseded" | "account-changed";

/** The signed-in username, or undefined when signed out. */
export function currentUsername(): string | undefined {
    const auth = globalState.getAuthSession();
    return auth && auth.state === "signed-in" && auth.identity ? auth.identity.username : undefined;
}

function currentClearance(): string {
    const auth = globalState.getAuthSession();
    return (auth && auth.cookie && getCookieValue(auth.cookie, "cf_clearance")) || "";
}

export interface IClearanceState {
    username: string | undefined;
    clearance: string;
}

function readClearanceState(): IClearanceState {
    return { username: currentUsername(), clearance: currentClearance() };
}

/**
 * Wait for the browser extension to sync a cf_clearance that differs from the
 * one that was challenged, for the same account.
 */
export function watchForFreshClearance(
    username: string,
    baseline: string,
    isAborted: () => boolean,
    timeoutMs: number = CLEARANCE_WAIT_MS,
    pollMs: number = CLEARANCE_POLL_MS,
    readState: () => IClearanceState = readClearanceState,
): { promise: Promise<ClearanceOutcome>; dispose: () => void } {
    let timer: NodeJS.Timer | undefined;
    let settle: (outcome: ClearanceOutcome) => void = () => undefined;
    const promise = new Promise<ClearanceOutcome>((resolve) => {
        const deadline: number = Date.now() + timeoutMs;
        settle = (outcome: ClearanceOutcome) => {
            if (timer) {
                clearInterval(timer);
                timer = undefined;
            }
            resolve(outcome);
        };
        const check = () => {
            const state: IClearanceState = readState();
            if (isAborted()) {
                settle("superseded");
            } else if (state.username !== username) {
                settle("account-changed");
            } else if (state.clearance && state.clearance !== baseline) {
                settle("synced");
            } else if (Date.now() >= deadline) {
                settle("timeout");
            }
        };
        timer = setInterval(check, pollMs);
        check();
    });
    return { promise, dispose: () => settle("cancelled") };
}

/**
 * Ask the user to clear the Cloudflare check in their browser, then wait for the
 * browser extension to sync a fresh clearance. Returns "synced" when the caller
 * may retry once.
 */
export async function recoverFromChallenge(
    operation: string,
    error: CloudflareChallengeError,
    username: string,
    isAborted: () => boolean,
): Promise<ClearanceOutcome> {
    // Subscribe before prompting so a fast sync is not missed.
    const watcher = watchForFreshClearance(username, currentClearance(), isAborted);
    leetCodeChannel.appendLine(`[${operation}] Cloudflare challenge persisted; waiting for the browser to sync a fresh clearance.`);

    const prompt: Thenable<string | undefined> = vscode.window.showWarningMessage(
        `${operation}: LeetCode's Cloudflare check blocked the request. Open the problem in your browser and complete the check; VS Code retries automatically once your browser syncs.`,
        OPEN_IN_BROWSER,
        "Cancel",
    );
    const first: ClearanceOutcome | string | undefined = await Promise.race([watcher.promise, prompt]);
    if (first !== OPEN_IN_BROWSER) {
        if (first === "synced" || first === "superseded" || first === "account-changed" || first === "timeout") {
            // The warning toast cannot be closed programmatically; say what happened.
            if (first === "synced") {
                vscode.window.setStatusBarMessage(`${operation}: fresh Cloudflare clearance synced, retrying...`, 5000);
            }
            return first;
        }
        watcher.dispose();
        return "cancelled";
    }

    if (error.problemUrl) {
        await openUrl(error.problemUrl);
    }
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true, title: `${operation}: waiting for browser sync after the Cloudflare check...` },
        (_p: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
            const subscription = token.onCancellationRequested(() => watcher.dispose());
            return watcher.promise.then((outcome: ClearanceOutcome) => {
                subscription.dispose();
                return outcome;
            });
        },
    );
}

/**
 * Run a judge attempt; on a persistent Cloudflare challenge, recover through the
 * browser and retry exactly once, resuming polling when the enqueue already ran.
 */
export async function runWithChallengeRecovery<T>(
    operation: string,
    username: string,
    isAborted: () => boolean,
    attempt: (resume: unknown) => Thenable<T>,
): Promise<T | undefined> {
    try {
        return await attempt(undefined);
    } catch (error) {
        if (!isCloudflareChallengeError(error) || isAborted()) {
            throw error;
        }
        const outcome: ClearanceOutcome = await recoverFromChallenge(operation, error, username, isAborted);
        leetCodeChannel.appendLine(`[${operation}] Cloudflare recovery outcome: ${outcome}.`);
        if (outcome === "cancelled" || outcome === "superseded" || outcome === "account-changed") {
            return undefined;
        }
        if (outcome === "timeout") {
            throw new Error(`${error.message} Timed out waiting for the browser to sync a fresh Cloudflare clearance.`);
        }
        return attempt(error.resume);
    }
}
