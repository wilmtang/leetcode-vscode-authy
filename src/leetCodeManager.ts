// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { Endpoint, IQuickItemEx, loginArgsMapping, urls, urlsCn, UserStatus } from "./shared";
import { createEnvOption } from "./utils/cpUtils";
import { DialogType, openUrl, promptForOpenOutputChannel } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";
import { getLeetCodeEndpoint } from "./commands/plugin";
import { globalState, IBrowserRequestHeaders } from "./globalState";
import { queryUserData } from "./request/query-user-data";
import { parseQuery } from "./utils/toolUtils";

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;
    private readonly successRegex: RegExp = /(?:.*)Successfully .*login as (.*)/i;
    private readonly failRegex: RegExp = /.*\[ERROR\].*/i;
    private readonly authSyncSignInTimeoutMs: number = 2 * 60 * 1000;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.handleUriSignIn = this.handleUriSignIn.bind(this);
    }

    public async getLoginStatus(): Promise<void> {
        try {
            const result: string = await leetCodeExecutor.getUserInfo();
            this.currentUser = this.tryParseUserName(result);
            this.userStatus = UserStatus.SignedIn;
        } catch (error) {
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            globalState.removeAll();
        } finally {
            this.emit("statusChanged");
        }
    }

    public async updateSessionFromCookie(cookie: string, browserUserAgent?: string, browserRequestHeaders?: IBrowserRequestHeaders): Promise<void> {
        await this.updateSyncedBrowserData(cookie, browserUserAgent, browserRequestHeaders);
        const data = await queryUserData();
        if (!data.isSignedIn || !data.username) {
            throw new Error("LeetCode did not return a signed-in user for the synced cookie.");
        }

        globalState.setUserStatus(data);
        await this.setCookieToCli(cookie, data.username);
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

        await this.updateSessionFromCookie(cookie || '')
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = []
        picks.push(
            {
                label: 'Auto Cookie Sync',
                detail: 'Wait for the browser extension to send your signed-in LeetCode session',
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
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching user data..." }, async () => {
                await this.handleInputCookieSignIn()
            });
        } catch (error) {
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async signOut(): Promise<void> {
        try {
            await leetCodeExecutor.signOut();
            vscode.window.showInformationMessage("Successfully signed out.");
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            globalState.removeAll();
            this.emit("statusChanged");
        } catch (error) {
            // swallow the error when sign out.
        }
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

        const signedIn: boolean = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Waiting for browser cookie sync...",
                cancellable: true,
            },
            async (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
                progress.report({ message: "In the browser extension, click Expire now, then open or refresh a leetcode.com page." });
                return this.waitForAuthSyncSignIn(token);
            }
        );

        if (!signedIn) {
            vscode.window.showWarningMessage("Still waiting for browser cookie sync. Sign in to LeetCode in your browser, click Expire now in the browser extension, then open or refresh a leetcode.com page.");
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

    private tryParseUserName(output: string): string {
        const reg: RegExp = /^\s*.\s*(.+?)\s*https:\/\/leetcode/m;
        const match: RegExpMatchArray | null = output.match(reg);
        if (match && match.length === 2) {
            return match[1].trim();
        }

        return "Unknown";
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

    public setCookieToCli(cookie: string, name: string): Promise<void> {
        return new Promise(async (resolve: (res: void) => void, reject: (e: Error) => void) => {
            const leetCodeBinaryPath: string = await leetCodeExecutor.getLeetCodeBinaryPath();

            const childProc: cp.ChildProcess = wsl.useWsl()
                ? cp.spawn("wsl", [leetCodeExecutor.node, leetCodeBinaryPath, "user", loginArgsMapping.get("Cookie") ?? ""], {
                      shell: true,
                  })
                : cp.spawn(leetCodeExecutor.node, [leetCodeBinaryPath, "user", loginArgsMapping.get("Cookie") ?? ""], {
                      shell: true,
                      env: createEnvOption(),
                  });

            childProc.stdout?.on("data", async (data: string | Buffer) => {
                data = data.toString();
                leetCodeChannel.append(data);
                const successMatch: RegExpMatchArray | null = data.match(this.successRegex);
                if (successMatch && successMatch[1]) {
                    childProc.stdin?.end();
                    return resolve();
                } else if (data.match(this.failRegex)) {
                    childProc.stdin?.end();
                    return reject(new Error("Faile to login"));
                } else if (data.match(/login: /)) {
                    childProc.stdin?.write(`${name}\n`);
                } else if (data.match(/cookie: /)) {
                    childProc.stdin?.write(`${cookie}\n`);
                }
            });

            childProc.stderr?.on("data", (data: string | Buffer) => leetCodeChannel.append(data.toString()));

            childProc.on("error", reject);
        });
    }
}

export const leetCodeManager: LeetCodeManager = new LeetCodeManager();
