// Copyright (c) leo.zhao. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const CookieKey = "leetcode-cookie";
const BrowserUserAgentKey = "leetcode-browser-user-agent";
const BrowserRequestHeadersKey = "leetcode-browser-request-headers";
const UserStatusKey = "leetcode-user-status";
const AuthSyncLastSyncedAtKey = "leetcode-auth-sync-last-synced-at";
const AuthSyncOwnerKey = "leetcode-auth-sync-owner";

export type UserDataType = {
    isSignedIn: boolean;
    isPremium: boolean;
    username: string;
    avatar: string;
    isVerified?: boolean;
};

export interface IAuthSyncOwnerRecord {
    service: string;
    windowId: string;
    windowLabel: string;
    pid: number;
    port: number;
    startedAt: number;
    heartbeatAt: number;
    controlToken: string;
}

export interface IBrowserRequestHeaders {
    [key: string]: string;
}

class GlobalState {
    private context: vscode.ExtensionContext;
    private _state: vscode.Memento;

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this._state = this.context.globalState;
    }

    public setCookie(cookie: string): any {
        return this._state.update(CookieKey, cookie);
    }
    public getCookie(): string | undefined {
        return this._state.get(CookieKey);
    }

    public setBrowserUserAgent(userAgent: string): any {
        return this._state.update(BrowserUserAgentKey, userAgent);
    }
    public getBrowserUserAgent(): string | undefined {
        return this._state.get(BrowserUserAgentKey);
    }

    public setBrowserRequestHeaders(headers: IBrowserRequestHeaders): any {
        return this._state.update(BrowserRequestHeadersKey, headers);
    }
    public getBrowserRequestHeaders(): IBrowserRequestHeaders | undefined {
        return this._state.get(BrowserRequestHeadersKey);
    }

    public setAuthSyncLastSyncedAt(timestamp: number): Thenable<void> {
        return this._state.update(AuthSyncLastSyncedAtKey, timestamp);
    }

    public getAuthSyncLastSyncedAt(): number | undefined {
        const timestamp: number | undefined = this._state.get(AuthSyncLastSyncedAtKey);
        return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
    }

    public setUserStatus(userStatus: UserDataType): any {
        return this._state.update(UserStatusKey, userStatus);
    }

    public getUserStatus(): UserDataType | undefined {
        return this._state.get(UserStatusKey);
    }

    public setAuthSyncOwner(owner: IAuthSyncOwnerRecord): Thenable<void> {
        return this._state.update(AuthSyncOwnerKey, owner);
    }

    public getAuthSyncOwner(): IAuthSyncOwnerRecord | undefined {
        const owner: IAuthSyncOwnerRecord | undefined = this._state.get(AuthSyncOwnerKey);
        if (!owner || owner.service !== "vscode-leetcode-auth-sync") {
            return undefined;
        }

        return owner;
    }

    public clearAuthSyncOwner(windowId?: string): Thenable<void> {
        const owner: IAuthSyncOwnerRecord | undefined = this.getAuthSyncOwner();
        if (windowId && owner && owner.windowId !== windowId) {
            return Promise.resolve();
        }

        return this._state.update(AuthSyncOwnerKey, undefined);
    }

    public removeCookie(): void {
        this._state.update(CookieKey, undefined);
        this._state.update(BrowserUserAgentKey, undefined);
        this._state.update(BrowserRequestHeadersKey, undefined);
    }

    public removeAll(): void {
        this._state.update(CookieKey, undefined);
        this._state.update(BrowserUserAgentKey, undefined);
        this._state.update(BrowserRequestHeadersKey, undefined);
        this._state.update(UserStatusKey, undefined);
        this._state.update(AuthSyncLastSyncedAtKey, undefined);
    }
}

export const globalState: GlobalState = new GlobalState();
