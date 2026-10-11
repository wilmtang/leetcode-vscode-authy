// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventEmitter } from "events";
import * as vscode from "vscode";
import {
    AuthIntentCoordinator,
    AuthIntentKind,
    IAuthIntent,
} from "./auth/authIntentCoordinator";
import { leetCodeChannel } from "./leetCodeChannel";
import { Endpoint, IQuickItemEx, urls, urlsCn, UserStatus } from "./shared";
import { DialogType, openUrl, promptForOpenOutputChannel } from "./utils/uiUtils";
import { getLeetCodeEndpoint } from "./commands/plugin";
import { globalState, IBrowserRequestHeaders, UserDataType } from "./globalState";
import { fetchUserStatus } from "./request/leetcode-api";
import { parseQuery } from "./utils/toolUtils";

const chromeAuthSyncExtensionUrl: string = "https://chromewebstore.google.com/detail/leetcode-vs-code-auth-syn/elbnajbjhllgodibfhbfiigfmcfpbnck";
const firefoxAuthSyncExtensionUrl: string = "https://addons.mozilla.org/en-US/firefox/addon/leetcode-vs-code-auth-sync/";
const installChromeExtensionAction: string = "Install Chrome Extension";
const installFirefoxAddOnAction: string = "Install Firefox Add-on";
const continueWaitingAction: string = "Continue Waiting";
const useCookieLoginAction: string = "Use Cookie Login";
const installChromeAction: string = "Install Chrome";
const installFirefoxAction: string = "Install Firefox";
const showAuthSyncStatusAction: string = "Show Auth Sync Status";

interface IAuthUpdateGuard {
    deadlineAt: number;
    isCancelled: () => boolean;
}

type AuthSyncWaitOutcome = "signedIn" | "timedOut" | "cancelled" | "unavailable";

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;
    private readonly authSyncSignInTimeoutMs: number = 2 * 60 * 1000;
    private readonly authIntents: AuthIntentCoordinator = new AuthIntentCoordinator();
    private appliedAuthRevision: number | undefined;
    private authSyncWaitInFlight: Promise<AuthSyncWaitOutcome> | undefined;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.handleUriSignIn = this.handleUriSignIn.bind(this);
    }

    // Determines sign-in state without shelling out to the CLI, so activation no
    // longer depends on Node. A cached identity is trusted immediately for an
    // instant, offline-tolerant cold start, then verified directly in the
    // background; with no cache we verify synchronously.
    public async getLoginStatus(): Promise<void> {
        const snapshot = globalState.getAuthSession();
        if (snapshot && snapshot.state === "signed-out") {
            this.appliedAuthRevision = snapshot.revision;
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            return;
        }
        const cookie: string | undefined = snapshot && snapshot.cookie;
        const cached: UserDataType | undefined = snapshot && snapshot.identity;
        if (cookie && cached && cached.isSignedIn && cached.username) {
            this.appliedAuthRevision = snapshot && snapshot.revision;
            this.currentUser = cached.username;
            this.userStatus = UserStatus.SignedIn;
            this.emit("statusChanged");
            void this.refreshUserStatus();
            return;
        }

        await this.refreshUserStatus();
    }

    // Verifies the synced cookie against the direct API. A HTTP-200 response with
    // isSignedIn=false means the cookie genuinely expired (clear state); a thrown
    // error is treated as transient/offline and keeps any cached identity so a
    // flaky network does not sign the user out.
    private async refreshUserStatus(): Promise<void> {
        const intent: IAuthIntent = this.authIntents.capture("refresh");
        try {
            const cookie: string | undefined = globalState.getCookie();
            if (!cookie) {
                await this.applySignedOut(intent);
                return;
            }

            const data: UserDataType = await fetchUserStatus(cookie);
            // A browser sync may rotate the credential while this background
            // verification is in flight. Never apply a response for an obsolete
            // cookie over the newer account state.
            if (!this.authIntents.isCurrent(intent) || globalState.getCookie() !== cookie) {
                return;
            }
            if (data.isSignedIn && data.username) {
                // Only emit when the identity actually changed; a no-op re-verify
                // (e.g. the background refresh after a cached cold start) must not
                // trigger another full catalog refetch.
                const changed: boolean = this.currentUser !== data.username || this.userStatus !== UserStatus.SignedIn;
                this.authIntents.assertCurrent(intent);
                await this.authIntents.commit(intent, () => Promise.resolve(globalState.setUserStatus(data)));
                this.currentUser = data.username;
                this.userStatus = UserStatus.SignedIn;
                if (changed) {
                    this.emit("statusChanged");
                }
            } else {
                await this.applySignedOut(intent);
            }
        } catch (error) {
            if (!this.authIntents.isCurrent(intent)) {
                return;
            }
            // Transient/offline error: keep any cached identity and stay quiet (no
            // state change, so no refresh). Only a definitive loss clears state.
            leetCodeChannel.appendLine(`[auth] Could not verify LeetCode session: ${error}`);
            if (!this.currentUser) {
                await this.applySignedOut(intent);
            }
        }
    }

    private async applySignedOut(intent: IAuthIntent): Promise<void> {
        this.authIntents.assertCurrent(intent);
        const changed: boolean = this.currentUser !== undefined || this.userStatus !== UserStatus.SignedOut;
        await this.authIntents.commit(intent, () => globalState.setSignedOutSession(false));
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        if (changed) {
            this.emit("statusChanged");
        }
    }

    public async updateSessionFromCookie(
        cookie: string,
        browserUserAgent?: string,
        browserRequestHeaders?: IBrowserRequestHeaders,
        kind: AuthIntentKind = "manual-cookie",
        guard?: IAuthUpdateGuard,
    ): Promise<void> {
        if (kind === "automatic-sync" && this.isAutomaticSyncSuspended()) {
            throw new Error("Automatic browser sync is suspended after explicit sign-out. Choose Sign In to resume it.");
        }
        const intent: IAuthIntent = this.authIntents.begin(kind);
        // Validate the candidate credential before replacing the last known-good
        // keychain entry. This also lets an account switch update the displayed
        // identity atomically instead of leaving a stale username beside a new
        // cookie when validation fails.
        const timeoutMs: number | undefined = guard ? Math.max(1, guard.deadlineAt - Date.now()) : undefined;
        const data: UserDataType = await fetchUserStatus(cookie, browserUserAgent, browserRequestHeaders, timeoutMs);
        if (guard && (guard.isCancelled() || Date.now() >= guard.deadlineAt)) {
            throw new Error("Auth sync request expired before validation completed.");
        }
        this.authIntents.assertCurrent(intent);
        if (!data.isSignedIn || !data.username) {
            throw new Error("LeetCode did not return a signed-in user for the synced cookie.");
        }

        const changed: boolean = this.currentUser !== data.username || this.userStatus !== UserStatus.SignedIn;
        // A replacement session must not retain browser metadata captured for
        // the previous account. Headerless same-session refreshes use
        // updateSyncedBrowserData() below and intentionally preserve it.
        const committed = await this.authIntents.commit(intent, () => globalState.setSignedInSession(cookie, data, browserUserAgent, browserRequestHeaders));
        this.appliedAuthRevision = committed.revision;
        this.currentUser = data.username;
        this.userStatus = UserStatus.SignedIn;
        if (changed) {
            vscode.window.showInformationMessage(`Successfully signed in as ${data.username}.`);
            this.emit("statusChanged");
        }
    }

    public async updateSyncedBrowserData(cookie: string, browserUserAgent?: string, browserRequestHeaders?: IBrowserRequestHeaders): Promise<void> {
        if (this.isAutomaticSyncSuspended()) {
            throw new Error("Automatic browser sync is suspended after explicit sign-out. Choose Sign In to resume it.");
        }
        const intent: IAuthIntent = this.authIntents.begin("automatic-sync");
        const committed = await this.authIntents.commit(intent, () => globalState.updateSignedInSession(cookie, browserUserAgent, browserRequestHeaders));
        this.appliedAuthRevision = committed.revision;
    }

    public async handleUriSignIn(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress: vscode.Progress<{}>) => {
                progress.report({ message: "Fetching user data..." });
                const queryParams = parseQuery(uri.query);
                const cookie = queryParams["cookie"];
                if (!cookie) {
                    promptForOpenOutputChannel(`Failed to get cookie. Please log in again`, DialogType.error);
                    return;
                }

                await this.updateSessionFromCookie(cookie, undefined, undefined, "uri");

            });
        } catch (error) {
            leetCodeChannel.appendLine(`[auth] URI sign-in failed: ${String(error)}`);
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async handleInputCookieSignIn(): Promise<void> {
        const cookie: string | undefined = await vscode.window.showInputBox({
            prompt: 'Enter LeetCode Cookie',
            password: true,
            ignoreFocusOut: true,
            validateInput: (s: string): string | undefined =>
                s && s.trim() ? undefined : 'Cookie must not be empty',
        });

        if (!cookie) {
            // User dismissed the input box; abort instead of attempting a login with an empty cookie.
            return;
        }

        await this.updateSessionFromCookie(cookie.trim());
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = []
        picks.push(
            {
                label: 'Auto Cookie Sync (requires browser extension)',
                detail: 'Install the companion browser extension, sign in to leetcode.com, then refresh a LeetCode page',
                value: 'AuthSync',
                description: '[Recommended]'
            },
            {
                label: 'LeetCode Cookie',
                detail: 'Use LeetCode cookie copied from browser to login',
                value: 'Cookie',
            },
            {
                label: 'Web Authorization',
                detail: 'Open browser to authorize login on the website',
                value: 'WebAuth',
                description: '[NOT Recommended]'
            },
        )

        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks)
        if (!choice) {
            return
        }
        const loginMethod: string = choice.value

        if (loginMethod === 'AuthSync') {
            await this.handleAuthSyncSignIn()
            return
        }

        if (loginMethod === 'WebAuth') {
            await openUrl(this.getAuthLoginUrl());
            return;
        }

        try {
            await this.handleCookieSignInWithProgress();
        } catch (error) {
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async signOut(): Promise<void> {
        // Sign-out is now purely local: clear the synced cookie/identity from
        // globalState. There is no CLI session to tear down.
        const intent: IAuthIntent = this.authIntents.begin("sign-out");
        const changed: boolean = this.currentUser !== undefined || this.userStatus !== UserStatus.SignedOut;
        const committed = await this.authIntents.commit(intent, () => globalState.setSignedOutSession(true));
        this.appliedAuthRevision = committed.revision;
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        if (changed) {
            this.emit("statusChanged");
        }
        vscode.window.showInformationMessage("Successfully signed out.");
    }

    public getStatus(): UserStatus {
        return this.userStatus;
    }

    public getUser(): string | undefined {
        return this.currentUser;
    }

    public isAutomaticSyncSuspended(): boolean {
        const snapshot = globalState.getAuthSession();
        return !!snapshot && snapshot.state === "signed-out" && snapshot.intentionalSignOut;
    }

    public reconcileAuthSession(snapshot: import("./globalState").IAuthSessionSnapshot): void {
        if (this.appliedAuthRevision === snapshot.revision) {
            return;
        }
        if (snapshot.source !== "local") {
            this.authIntents.begin("remote-sync");
        }
        this.appliedAuthRevision = snapshot.revision;
        const nextUser: string | undefined = snapshot.state === "signed-in" && snapshot.identity
            ? snapshot.identity.username
            : undefined;
        const nextStatus: UserStatus = nextUser ? UserStatus.SignedIn : UserStatus.SignedOut;
        const changed: boolean = nextUser !== this.currentUser || nextStatus !== this.userStatus;
        this.currentUser = nextUser;
        this.userStatus = nextStatus;
        if (changed || snapshot.state === "signed-in") {
            this.emit("statusChanged");
        }
    }

    private async handleAuthSyncSignIn(): Promise<void> {
        if (this.currentUser) {
            vscode.window.showInformationMessage(`Already signed in as ${this.currentUser}.`);
            return;
        }

        if (this.isAutomaticSyncSuspended()) {
            const intent: IAuthIntent = this.authIntents.begin("automatic-sync");
            const committed = await this.authIntents.commit(intent, () => globalState.setSignedOutSession(false));
            this.appliedAuthRevision = committed.revision;
        }

        if (!globalState.getAuthSyncLastSyncedAt()) {
            const shouldContinueWaiting: boolean = await this.promptForFirstAuthSyncSetup();
            if (!shouldContinueWaiting) {
                return;
            }
        }

        const outcome: AuthSyncWaitOutcome = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Waiting for browser cookie sync...",
                cancellable: true,
            },
            async (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                progress.report({
                    message: "Install or enable the browser extension, sign in to leetcode.com, click Expire now, then refresh a LeetCode page."
                });
                return this.waitForAuthSyncSignIn(token);
            }
        );

        if (outcome === "timedOut" || outcome === "unavailable") {
            await this.showAuthSyncNoSyncWarning();
        }
    }

    private async handleCookieSignInWithProgress(): Promise<void> {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching user data..." }, async () => {
            await this.handleInputCookieSignIn();
        });
    }

    private async promptForFirstAuthSyncSetup(): Promise<boolean> {
        const choice: string | undefined = await vscode.window.showInformationMessage(
            "Auto Cookie Sync needs the LeetCode VS Code Authy browser extension installed in Chrome or Firefox.",
            installChromeExtensionAction,
            installFirefoxAddOnAction,
            continueWaitingAction,
            useCookieLoginAction
        );

        switch (choice) {
            case installChromeExtensionAction:
                await openUrl(chromeAuthSyncExtensionUrl);
                return true;
            case installFirefoxAddOnAction:
                await openUrl(firefoxAuthSyncExtensionUrl);
                return true;
            case useCookieLoginAction:
                try {
                    await this.handleCookieSignInWithProgress();
                } catch (error) {
                    promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
                }
                return false;
            case continueWaitingAction:
                return true;
            default:
                return false;
        }
    }

    private async showAuthSyncNoSyncWarning(): Promise<void> {
        const choice: string | undefined = await vscode.window.showWarningMessage(
            "No browser sync was received. Auto Cookie Sync only works when the companion browser extension is installed, enabled, and using the same port as VS Code.",
            installChromeAction,
            installFirefoxAction,
            showAuthSyncStatusAction,
            useCookieLoginAction
        );

        switch (choice) {
            case installChromeAction:
                await openUrl(chromeAuthSyncExtensionUrl);
                break;
            case installFirefoxAction:
                await openUrl(firefoxAuthSyncExtensionUrl);
                break;
            case showAuthSyncStatusAction:
                await vscode.commands.executeCommand("leetcode.authSync.status");
                break;
            case useCookieLoginAction:
                try {
                    await this.handleCookieSignInWithProgress();
                } catch (error) {
                    promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
                }
                break;
            default:
                break;
        }
    }

    private waitForAuthSyncSignIn(token: vscode.CancellationToken): Promise<AuthSyncWaitOutcome> {
        if (!vscode.workspace.getConfiguration("leetcode").get<boolean>("authSync.enabled", true)) {
            return Promise.resolve("unavailable");
        }
        if (this.authSyncWaitInFlight) {
            return this.authSyncWaitInFlight;
        }
        const operation: Promise<AuthSyncWaitOutcome> = new Promise<AuthSyncWaitOutcome>((resolve: (outcome: AuthSyncWaitOutcome) => void) => {
            let timeout: NodeJS.Timer | undefined;
            let cancellationSubscription: vscode.Disposable | undefined;
            let resolved: boolean = false;

            const cleanup = (): void => {
                this.removeListener("statusChanged", onStatusChanged);
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                if (cancellationSubscription) {
                    cancellationSubscription.dispose();
                    cancellationSubscription = undefined;
                }
            };

            const finish = (outcome: AuthSyncWaitOutcome): void => {
                if (resolved) {
                    return;
                }
                resolved = true;
                cleanup();
                resolve(outcome);
            };

            const onStatusChanged = (): void => {
                if (this.userStatus === UserStatus.SignedIn && !!this.currentUser) {
                    finish("signedIn");
                }
            };

            this.on("statusChanged", onStatusChanged);
            cancellationSubscription = token.onCancellationRequested(() => finish("cancelled"));
            timeout = setTimeout(() => finish("timedOut"), this.authSyncSignInTimeoutMs);
            onStatusChanged();
        });
        this.authSyncWaitInFlight = operation;
        operation.then(() => { this.authSyncWaitInFlight = undefined; }, () => { this.authSyncWaitInFlight = undefined; });
        return operation;
    }

    public getAuthLoginUrl(): string {
        switch (getLeetCodeEndpoint()) {
            case Endpoint.LeetCodeCN:
                return urlsCn.authLoginUrl;
            case Endpoint.LeetCode:
            default:
                return urls.authLoginUrl;
        }
    }
}

export const leetCodeManager: LeetCodeManager = new LeetCodeManager();
