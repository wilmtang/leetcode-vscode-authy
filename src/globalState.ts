// Copyright (c) leo.zhao. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";

// Non-secret keys live in the workspace/global Memento (plaintext SQLite). These
// carry only public identity (username/avatar), timestamps, and local port-owner
// bookkeeping — nothing that grants account access.
const UserStatusKey = "leetcode-user-status";
const AuthSyncLastSyncedAtKey = "leetcode-auth-sync-last-synced-at";
const AuthSyncOwnerKey = "leetcode-auth-sync-owner";

// Secret keys live in context.secrets (OS-keychain backed), NOT the Memento. The
// LeetCode session cookie is a full account bearer, and the captured browser
// request headers can include an Authorization header, so both are credentials
// and must not sit in plaintext on disk. (Audit 2 / A2-1.) These same names were
// previously stored in the Memento; initialize() migrates any legacy plaintext
// value into the keychain and deletes the old copy so upgrades don't sign out.
const CookieSecretKey = "leetcode-cookie";
const BrowserUserAgentSecretKey = "leetcode-browser-user-agent";
const BrowserRequestHeadersSecretKey = "leetcode-browser-request-headers";
const SECRET_KEYS: string[] = [CookieSecretKey, BrowserUserAgentSecretKey, BrowserRequestHeadersSecretKey];

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
    // In-memory mirror of the keychain-backed secrets. SecretStorage is async-only,
    // but the cookie/header getters are called from many synchronous code paths
    // (createHeaders, getRequiredCookie, …). Hydrating a cache at activation and
    // refreshing it on every write — and on cross-window keychain changes — lets
    // those getters stay synchronous without holding credentials in the Memento.
    private cookieCache: string | undefined;
    private browserUserAgentCache: string | undefined;
    private browserRequestHeadersCache: IBrowserRequestHeaders | undefined;

    // Must be awaited before any cookie/header read. extension.ts awaits this
    // before wiring sign-in or starting the auth-sync server.
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        this._state = this.context.globalState;
        await this.migrateLegacyPlaintextSecrets();
        await this.hydrateSecretCache();
        // A sibling VS Code window (or an external keychain edit) can rotate the
        // synced cookie; re-hydrate so this window's cache never serves a stale
        // credential after another window re-syncs. (Replaces the implicit
        // freshness the old Memento getter had by reading on every call.)
        context.subscriptions.push(
            context.secrets.onDidChange((event: vscode.SecretStorageChangeEvent) => {
                if (SECRET_KEYS.indexOf(event.key) >= 0) {
                    void this.hydrateSecretCache();
                }
            }),
        );
    }

    public setCookie(cookie: string): Thenable<void> {
        this.cookieCache = cookie;
        return this.context.secrets.store(CookieSecretKey, cookie);
    }
    public getCookie(): string | undefined {
        return this.cookieCache;
    }

    public setBrowserUserAgent(userAgent: string): Thenable<void> {
        this.browserUserAgentCache = userAgent;
        return this.context.secrets.store(BrowserUserAgentSecretKey, userAgent);
    }
    public getBrowserUserAgent(): string | undefined {
        return this.browserUserAgentCache;
    }

    public setBrowserRequestHeaders(headers: IBrowserRequestHeaders): Thenable<void> {
        this.browserRequestHeadersCache = headers;
        // SecretStorage holds strings only, so the header map is JSON-encoded.
        return this.context.secrets.store(BrowserRequestHeadersSecretKey, JSON.stringify(headers));
    }
    public getBrowserRequestHeaders(): IBrowserRequestHeaders | undefined {
        return this.browserRequestHeadersCache;
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

    // Clears the synced credentials (cache + keychain). Returns a promise so
    // callers that need the secret gone before continuing can await it; the
    // legacy Memento copies are best-effort cleared too in case migration was
    // skipped on this machine.
    public removeCookie(): Thenable<void> {
        return this.clearSecrets();
    }

    public removeAll(): Thenable<void> {
        void this._state.update(UserStatusKey, undefined);
        void this._state.update(AuthSyncLastSyncedAtKey, undefined);
        return this.clearSecrets();
    }

    private clearSecrets(): Thenable<void> {
        this.cookieCache = undefined;
        this.browserUserAgentCache = undefined;
        this.browserRequestHeadersCache = undefined;
        // Best-effort clear of any leftover legacy plaintext values as well.
        for (const key of SECRET_KEYS) {
            void this._state.update(key, undefined);
        }
        return Promise.all(SECRET_KEYS.map((key: string) => this.context.secrets.delete(key))).then(() => undefined);
    }

    // Loads the keychain values into the synchronous cache. Bad JSON in the
    // headers blob is tolerated (treated as absent) so one corrupt entry can't
    // wedge activation.
    private async hydrateSecretCache(): Promise<void> {
        this.cookieCache = await this.context.secrets.get(CookieSecretKey) || undefined;
        this.browserUserAgentCache = await this.context.secrets.get(BrowserUserAgentSecretKey) || undefined;
        const rawHeaders: string | undefined = await this.context.secrets.get(BrowserRequestHeadersSecretKey);
        this.browserRequestHeadersCache = this.parseHeaders(rawHeaders);
    }

    private parseHeaders(raw: string | undefined): IBrowserRequestHeaders | undefined {
        if (!raw) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as IBrowserRequestHeaders : undefined;
        } catch (error) {
            return undefined;
        }
    }

    // One-time move of credentials written by pre-A2-1 builds (plaintext Memento)
    // into the keychain, then delete the plaintext copy. Runs every activation but
    // no-ops once the Memento keys are gone.
    private async migrateLegacyPlaintextSecrets(): Promise<void> {
        for (const key of SECRET_KEYS) {
            const legacy: unknown = this._state.get(key);
            if (legacy === undefined || legacy === null) {
                continue;
            }
            const value: string = typeof legacy === "string" ? legacy : JSON.stringify(legacy);
            if ((await this.context.secrets.get(key)) === undefined) {
                await this.context.secrets.store(key, value);
            }
            await this._state.update(key, undefined);
        }
    }
}

export const globalState: GlobalState = new GlobalState();
