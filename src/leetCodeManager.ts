// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { EventEmitter } from "events";
import * as vscode from "vscode";
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

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;
    private readonly authSyncSignInTimeoutMs: number = 2 * 60 * 1000;

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
        const cookie: string | undefined = globalState.getCookie();
        const cached: UserDataType | undefined = globalState.getUserStatus();
        if (cookie && cached && cached.isSignedIn && cached.username) {
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
        try {
            if (!globalState.getCookie()) {
                this.applySignedOut();
                return;
            }

            const data: UserDataType = await fetchUserStatus();
            if (data.isSignedIn && data.username) {
                // Only emit when the identity actually changed; a no-op re-verify
                // (e.g. the background refresh after a cached cold start) must not
                // trigger another full catalog refetch.
                const changed: boolean = this.currentUser !== data.username || this.userStatus !== UserStatus.SignedIn;
                globalState.setUserStatus(data);
                this.currentUser = data.username;
                this.userStatus = UserStatus.SignedIn;
                if (changed) {
                    this.emit("statusChanged");
                }
            } else {
                this.applySignedOut();
            }
        } catch (error) {
            // Transient/offline error: keep any cached identity and stay quiet (no
            // state change, so no refresh). Only a definitive loss clears state.
            leetCodeChannel.appendLine(`[auth] Could not verify LeetCode session: ${error}`);
            if (!this.currentUser) {
                this.applySignedOut();
            }
        }
    }

    private applySignedOut(): void {
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        globalState.removeAll();
        this.emit("statusChanged");
    }

    public async updateSessionFromCookie(cookie: string, browserUserAgent?: string, browserRequestHeaders?: IBrowserRequestHeaders): Promise<void> {
        await this.updateSyncedBrowserData(cookie, browserUserAgent, browserRequestHeaders);
        const data = await fetchUserStatus();
        if (!data.isSignedIn || !data.username) {
            throw new Error("LeetCode did not return a signed-in user for the synced cookie.");
        }

        globalState.setUserStatus(data);
        vscode.window.showInformationMessage(`Successfully signed in as ${data.username}.`);
        this.currentUser = data.username;
        this.userStatus = UserStatus.SignedIn;
        this.emit("statusChanged");
    }

    public async updateSyncedBrowserData(cookie: string, browserUserAgent?: string, browserRequestHeaders?: IBrowserRequestHeaders): Promise<void> {
        await globalState.setCookie(cookie);
        if (browserUserAgent) {
            await globalState.setBrowserUserAgent(browserUserAgent);
        }
        if (browserRequestHeaders && Object.keys(browserRequestHeaders).length > 0) {
            await globalState.setBrowserRequestHeaders(browserRequestHeaders);
        }
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

                await this.updateSessionFromCookie(cookie)

            });
        } catch (error) {
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async handleInputCookieSignIn(): Promise<void> {
        const cookie: string | undefined = await vscode.window.showInputBox({
            prompt: 'Enter LeetCode Cookie',
            password: true,
            ignoreFocusOut: true,
            validateInput: (s: string): string | undefined =>
                s ? undefined : 'Cookie must not be empty',
        })

        if (!cookie) {
            // User dismissed the input box; abort instead of attempting a login with an empty cookie.
            return
        }

        await this.updateSessionFromCookie(cookie)
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
            openUrl(this.getAuthLoginUrl())
            return
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
        globalState.removeAll();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.emit("statusChanged");
        vscode.window.showInformationMessage("Successfully signed out.");
    }

    public getStatus(): UserStatus {
        return this.userStatus;
    }

    public getUser(): string | undefined {
        return this.currentUser;
    }

    private async handleAuthSyncSignIn(): Promise<void> {
        if (this.currentUser) {
            vscode.window.showInformationMessage(`Already signed in as ${this.currentUser}.`);
            return;
        }

        if (!globalState.getAuthSyncLastSyncedAt()) {
            const shouldContinueWaiting: boolean = await this.promptForFirstAuthSyncSetup();
            if (!shouldContinueWaiting) {
                return;
            }
        }

        const signedIn: boolean = await vscode.window.withProgress(
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

        if (!signedIn) {
            await this.showAuthSyncNoSyncWarning();
        }
    }

    private async handleCookieSignInWithProgress(): Promise<void> {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching user data..." }, async () => {
            await this.handleInputCookieSignIn()
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
            default:
                return true;
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

    private waitForAuthSyncSignIn(token: vscode.CancellationToken): Promise<boolean> {
        return new Promise<boolean>((resolve: (signedIn: boolean) => void) => {
            let timeout: NodeJS.Timer | undefined;
            let pollInterval: NodeJS.Timer | undefined;
            let cancellationSubscription: vscode.Disposable | undefined;
            let resolved: boolean = false;
            let pollInFlight: boolean = false;

            const cleanup = (): void => {
                this.removeListener("statusChanged", onStatusChanged);
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                if (pollInterval) {
                    clearInterval(pollInterval);
                    pollInterval = undefined;
                }
                if (cancellationSubscription) {
                    cancellationSubscription.dispose();
                    cancellationSubscription = undefined;
                }
            };

            const finish = (signedIn: boolean): void => {
                if (resolved) {
                    return;
                }
                resolved = true;
                cleanup();
                resolve(signedIn);
            };

            const onStatusChanged = (): void => {
                if (this.userStatus === UserStatus.SignedIn && !!this.currentUser) {
                    finish(true);
                }
            };

            const pollLoginStatus = async (): Promise<void> => {
                if (resolved || pollInFlight) {
                    return;
                }

                pollInFlight = true;
                try {
                    await this.getLoginStatus();
                } finally {
                    pollInFlight = false;
                    onStatusChanged();
                }
            };

            this.on("statusChanged", onStatusChanged);
            cancellationSubscription = token.onCancellationRequested(() => finish(false));
            timeout = setTimeout(() => finish(false), this.authSyncSignInTimeoutMs);
            pollInterval = setInterval(() => {
                void pollLoginStatus();
            }, 2000);
            onStatusChanged();
            void pollLoginStatus();
        });
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
