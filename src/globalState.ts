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
const AuthSessionSecretKey = "leetcode-auth-session-v1";
const LEGACY_SECRET_KEYS: string[] = [CookieSecretKey, BrowserUserAgentSecretKey, BrowserRequestHeadersSecretKey];

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

export interface IAuthSessionSnapshot {
    version: 1;
    revision: number;
    state: "signed-in" | "signed-out";
    intentionalSignOut: boolean;
    cookie?: string;
    browserUserAgent?: string;
    browserRequestHeaders?: IBrowserRequestHeaders;
    identity?: UserDataType;
}

class GlobalState {
    private context: vscode.ExtensionContext;
    private _state: vscode.Memento;
    // In-memory mirror of the keychain-backed secrets. SecretStorage is async-only,
    // but the cookie/header getters are called from many synchronous code paths
    // (createHeaders, getRequiredCookie, …). Hydrating a cache at activation and
    // refreshing it on every write — and on cross-window keychain changes — lets
    // those getters stay synchronous without holding credentials in the Memento.
    private authSessionCache: IAuthSessionSnapshot | undefined;

    // Must be awaited before any cookie/header read. extension.ts awaits this
    // before wiring sign-in or starting the auth-sync server.
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        this._state = this.context.globalState;
        await this.migrateAuthSession();
        await this.hydrateAuthSessionCache();
        // A sibling VS Code window (or an external keychain edit) can rotate the
        // synced cookie; re-hydrate so this window's cache never serves a stale
        // credential after another window re-syncs. (Replaces the implicit
        // freshness the old Memento getter had by reading on every call.)
        context.subscriptions.push(
            context.secrets.onDidChange((event: vscode.SecretStorageChangeEvent) => {
                if (event.key === AuthSessionSecretKey) {
                    void this.hydrateAuthSessionCache();
                }
            }),
        );
    }

    public async setCookie(cookie: string): Promise<void> {
        await this.persistAuthSession({
            ...this.currentOrSignedOut(),
            revision: this.nextRevision(),
            state: "signed-in",
            intentionalSignOut: false,
            cookie,
        });
    }
    public getCookie(): string | undefined {
        return this.authSessionCache && this.authSessionCache.state === "signed-in"
            ? this.authSessionCache.cookie
            : undefined;
    }

    public async setBrowserUserAgent(userAgent: string | undefined): Promise<void> {
        await this.persistAuthSession({ ...this.currentOrSignedOut(), revision: this.nextRevision(), browserUserAgent: userAgent });
    }
    public getBrowserUserAgent(): string | undefined {
        return this.authSessionCache && this.authSessionCache.browserUserAgent;
    }

    public async setBrowserRequestHeaders(headers: IBrowserRequestHeaders | undefined): Promise<void> {
        await this.persistAuthSession({ ...this.currentOrSignedOut(), revision: this.nextRevision(), browserRequestHeaders: headers });
    }
    public getBrowserRequestHeaders(): IBrowserRequestHeaders | undefined {
        return this.authSessionCache && this.cloneHeaders(this.authSessionCache.browserRequestHeaders);
    }

    public getAuthSession(): IAuthSessionSnapshot | undefined {
        return this.authSessionCache ? this.cloneAuthSession(this.authSessionCache) : undefined;
    }

    public isAuthRevisionCurrent(revision: number): boolean {
        return !!this.authSessionCache && this.authSessionCache.revision === revision;
    }

    public async setSignedInSession(
        cookie: string,
        identity: UserDataType,
        browserUserAgent?: string,
        browserRequestHeaders?: IBrowserRequestHeaders,
    ): Promise<IAuthSessionSnapshot> {
        return this.persistAuthSession({
            version: 1,
            revision: this.nextRevision(),
            state: "signed-in",
            intentionalSignOut: false,
            cookie,
            browserUserAgent,
            browserRequestHeaders,
            identity,
        });
    }

    public async updateSignedInSession(
        cookie: string,
        browserUserAgent?: string,
        browserRequestHeaders?: IBrowserRequestHeaders,
    ): Promise<IAuthSessionSnapshot> {
        const current: IAuthSessionSnapshot | undefined = this.getAuthSession();
        if (!current || current.state !== "signed-in" || !current.identity) {
            throw new Error("Cannot update browser credentials without a validated signed-in session.");
        }
        const nextUserAgent: string | undefined = browserUserAgent || current.browserUserAgent;
        const nextHeaders: IBrowserRequestHeaders | undefined = browserRequestHeaders && Object.keys(browserRequestHeaders).length > 0
            ? browserRequestHeaders
            : current.browserRequestHeaders;
        if (
            current.cookie === cookie &&
            current.browserUserAgent === nextUserAgent &&
            JSON.stringify(current.browserRequestHeaders || {}) === JSON.stringify(nextHeaders || {})
        ) {
            return current;
        }
        return this.setSignedInSession(
            cookie,
            current.identity,
            nextUserAgent,
            nextHeaders,
        );
    }

    public setAuthSyncLastSyncedAt(timestamp: number): Thenable<void> {
        return this._state.update(AuthSyncLastSyncedAtKey, timestamp);
    }

    public getAuthSyncLastSyncedAt(): number | undefined {
        const timestamp: number | undefined = this._state.get(AuthSyncLastSyncedAtKey);
        return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
    }

    public setUserStatus(userStatus: UserDataType): Thenable<void> {
        const current: IAuthSessionSnapshot = this.currentOrSignedOut();
        return this.persistAuthSession({ ...current, revision: this.nextRevision(), identity: userStatus }).then(() => undefined);
    }

    public getUserStatus(): UserDataType | undefined {
        return this.authSessionCache && this.authSessionCache.identity;
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
    // callers that need the secret gone before continuing can await it; legacy
    // Memento copies are cleared too in case migration was skipped.
    public removeCookie(): Thenable<void> {
        return this.setSignedOutSession(false).then(() => undefined);
    }

    public async removeAll(): Promise<void> {
        await this.setSignedOutSession(false);
        await this._state.update(AuthSyncLastSyncedAtKey, undefined);
    }

    public async setSignedOutSession(intentional: boolean): Promise<IAuthSessionSnapshot> {
        return this.persistAuthSession({
            version: 1,
            revision: this.nextRevision(),
            state: "signed-out",
            intentionalSignOut: intentional,
        });
    }

    private async persistAuthSession(snapshot: IAuthSessionSnapshot): Promise<IAuthSessionSnapshot> {
        const normalized: IAuthSessionSnapshot = this.normalizeAuthSession({
            ...snapshot,
            version: 1,
            revision: snapshot.revision > 0 ? snapshot.revision : this.nextRevision(),
        });
        await this.context.secrets.store(AuthSessionSecretKey, JSON.stringify(normalized));
        this.authSessionCache = normalized;
        return this.cloneAuthSession(normalized);
    }

    private async hydrateAuthSessionCache(): Promise<void> {
        const raw: string | undefined = await this.context.secrets.get(AuthSessionSecretKey);
        this.authSessionCache = this.parseAuthSession(raw);
    }

    private parseHeaders(raw: string | undefined): IBrowserRequestHeaders | undefined {
        if (!raw) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return undefined;
            }
            const parsedObject: { [key: string]: unknown } = parsed as { [key: string]: unknown };
            const headers: IBrowserRequestHeaders = {};
            for (const key of Object.keys(parsedObject)) {
                const value: unknown = parsedObject[key];
                if (typeof value === "string") {
                    headers[key] = value;
                }
            }
            return Object.keys(headers).length > 0 ? headers : undefined;
        } catch (error) {
            return undefined;
        }
    }

    private async migrateAuthSession(): Promise<void> {
        if (this.parseAuthSession(await this.context.secrets.get(AuthSessionSecretKey))) {
            await this.clearLegacyAuthFields();
            return;
        }

        const cookie: string | undefined = await this.readLegacySecret(CookieSecretKey);
        const browserUserAgent: string | undefined = await this.readLegacySecret(BrowserUserAgentSecretKey);
        const rawHeaders: string | undefined = await this.readLegacySecret(BrowserRequestHeadersSecretKey);
        const identity: UserDataType | undefined = this._state.get(UserStatusKey);
        const snapshot: IAuthSessionSnapshot = cookie && identity && identity.isSignedIn && identity.username
            ? {
                version: 1,
                revision: 1,
                state: "signed-in",
                intentionalSignOut: false,
                cookie,
                browserUserAgent,
                browserRequestHeaders: this.parseHeaders(rawHeaders),
                identity,
            }
            : { version: 1, revision: 1, state: "signed-out", intentionalSignOut: false };

        // Store the complete replacement first. If this fails, every legacy field
        // remains available to the prior extension version; cleanup happens only
        // after the atomic record is durable.
        await this.context.secrets.store(AuthSessionSecretKey, JSON.stringify(snapshot));
        await this.clearLegacyAuthFields();
    }

    private async clearLegacyAuthFields(): Promise<void> {
        await Promise.all([
            this._state.update(UserStatusKey, undefined),
            ...LEGACY_SECRET_KEYS.map((key: string) => this._state.update(key, undefined)),
            ...LEGACY_SECRET_KEYS.map((key: string) => this.context.secrets.delete(key)),
        ]);
    }

    private async readLegacySecret(key: string): Promise<string | undefined> {
        const secret: string | undefined = await this.context.secrets.get(key);
        if (secret !== undefined) {
            return secret;
        }
        const legacy: unknown = this._state.get(key);
        if (legacy === undefined || legacy === null) {
            return undefined;
        }
        return typeof legacy === "string" ? legacy : JSON.stringify(legacy);
    }

    private parseAuthSession(raw: string | undefined): IAuthSessionSnapshot | undefined {
        if (!raw) {
            return undefined;
        }
        try {
            return this.normalizeAuthSession(JSON.parse(raw) as IAuthSessionSnapshot);
        } catch (error) {
            return undefined;
        }
    }

    private normalizeAuthSession(value: IAuthSessionSnapshot): IAuthSessionSnapshot {
        if (!value || value.version !== 1 || !Number.isFinite(value.revision) || value.revision < 1) {
            throw new Error("Stored LeetCode authentication snapshot is invalid.");
        }
        if (value.state === "signed-out") {
            return {
                version: 1,
                revision: value.revision,
                state: "signed-out",
                intentionalSignOut: !!value.intentionalSignOut,
            };
        }
        if (value.state !== "signed-in" || !value.cookie || !value.identity || !value.identity.username) {
            throw new Error("Stored LeetCode signed-in snapshot is incomplete.");
        }
        return {
            version: 1,
            revision: value.revision,
            state: "signed-in",
            intentionalSignOut: false,
            cookie: value.cookie,
            browserUserAgent: value.browserUserAgent,
            browserRequestHeaders: this.cloneHeaders(value.browserRequestHeaders),
            identity: { ...value.identity },
        };
    }

    private currentOrSignedOut(): IAuthSessionSnapshot {
        return this.getAuthSession() || {
            version: 1,
            revision: 1,
            state: "signed-out",
            intentionalSignOut: false,
        };
    }

    private nextRevision(): number {
        const current: number = this.authSessionCache ? this.authSessionCache.revision : 0;
        // SecretStorage is shared by sibling extension hosts but offers no CAS.
        // A timestamp plus random fraction makes concurrently-created revisions
        // distinct while retaining a numeric, increasing per-window revision.
        return Math.max(current + 1, Date.now() + Math.random());
    }

    private cloneAuthSession(snapshot: IAuthSessionSnapshot): IAuthSessionSnapshot {
        return {
            ...snapshot,
            browserRequestHeaders: this.cloneHeaders(snapshot.browserRequestHeaders),
            identity: snapshot.identity ? { ...snapshot.identity } : undefined,
        };
    }

    private cloneHeaders(headers: IBrowserRequestHeaders | undefined): IBrowserRequestHeaders | undefined {
        return headers ? { ...headers } : undefined;
    }
}

export const globalState: GlobalState = new GlobalState();
