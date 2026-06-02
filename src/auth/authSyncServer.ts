// Copyright (c) wilmtang. All rights reserved.
// Licensed under the MIT license.

import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { globalState, IAuthSyncOwnerRecord, IBrowserRequestHeaders } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import { UserStatus } from "../shared";
import { describePortOwner, IAuthSyncPortConflict } from "./authSyncPortInspector";

const DEFAULT_PORT: number = 17899;
const HOST: string = "127.0.0.1";
const MAX_BODY_BYTES: number = 64 * 1024;
const SECRET_HEADER: string = "x-leetcode-authsync-secret";
const CONTROL_HEADER: string = "x-leetcode-authsync-control-token";
const AUTH_SYNC_SERVICE: string = "vscode-leetcode-auth-sync";
const HEALTH_PATH: string = "/health";
const RELEASE_PATH: string = "/auth/release";
const DEFAULT_HEARTBEAT_SECONDS: number = 30;
const DEFAULT_OBSERVER_CHECK_SECONDS: number = 60;
const FORCE_RELEASE_TIMEOUT_MS: number = 10 * 1000;

export type AuthSyncServerMode = "disabled" | "stopped" | "local" | "observer" | "conflict" | "vacant";

export interface IAuthSyncOwnershipSettings {
    heartbeatMs: number;
    observerCheckMs: number;
}

export type AuthSyncOwnerInfo = Omit<IAuthSyncOwnerRecord, "controlToken">;

export interface IAuthSyncStatusSnapshot {
    mode: AuthSyncServerMode;
    port?: number;
    currentWindow: IAuthSyncWindowIdentity;
    owner?: AuthSyncOwnerInfo;
    conflict?: IAuthSyncPortConflict;
    ownershipSettings: IAuthSyncOwnershipSettings;
}

export interface IAuthSyncWindowIdentity {
    windowId: string;
    windowLabel: string;
    pid: number;
    startedAt: number;
}

export type AuthSyncForceStartResult =
    | { kind: "disabled"; port: number }
    | { kind: "started"; port: number }
    | { kind: "claimed"; port: number; previousOwner: AuthSyncOwnerInfo }
    | { kind: "releaseFailed"; port: number; owner?: AuthSyncOwnerInfo; message: string }
    | { kind: "portConflict"; port: number; conflict: IAuthSyncPortConflict };

class AuthSyncServer implements vscode.Disposable {
    private server: http.Server | undefined;
    private port: number | undefined;
    private mode: AuthSyncServerMode = "stopped";
    private pending: Promise<unknown> = Promise.resolve();
    private heartbeatTimer: NodeJS.Timer | undefined;
    private observerTimer: NodeJS.Timer | undefined;
    private observerCheckInFlight: boolean = false;
    private lastObservedAuthSyncAt: number | undefined;
    private lastConflict: IAuthSyncPortConflict | undefined;
    private observedOwner: AuthSyncOwnerInfo | undefined;
    private readonly windowId: string = crypto.randomBytes(6).toString("hex");
    private readonly startedAt: number = Date.now();
    private readonly controlToken: string = crypto.randomBytes(24).toString("hex");

    public start(): Promise<void> {
        return this.enqueue(() => this.startInternal());
    }

    public stop(): Promise<void> {
        return this.enqueue(() => this.stopInternal());
    }

    public forceStart(): Promise<AuthSyncForceStartResult> {
        return this.enqueue(() => this.forceStartInternal());
    }

    public isRunning(): boolean {
        return this.mode === "local" && !!this.server;
    }

    public getPort(): number | undefined {
        return this.port;
    }

    public refreshStatus(): Promise<void> {
        return this.enqueue(() => this.refreshStatusInternal());
    }

    public getStatusSnapshot(): IAuthSyncStatusSnapshot {
        return {
            mode: this.mode,
            port: this.port,
            currentWindow: this.getCurrentWindowIdentity(),
            owner: this.getSnapshotOwner(),
            conflict: this.lastConflict,
            ownershipSettings: this.getOwnershipSettings(),
        };
    }

    public dispose(): void {
        void this.stop();
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next: Promise<T> = this.pending.then(operation, operation);
        this.pending = next.then(() => undefined, () => undefined);
        return next;
    }

    private async startInternal(): Promise<void> {
        const serverSettings: IAuthSyncServerSettings = this.getServerSettings();

        if (!serverSettings.enabled) {
            await this.stopInternal();
            this.mode = "disabled";
            leetCodeChannel.appendLine("[auth-sync] Server is disabled.");
            return;
        }

        if (this.server && this.port === serverSettings.port) {
            this.mode = "local";
            this.startHeartbeatTimer();
            return;
        }

        await this.stopInternal();

        try {
            await this.listenLocal(serverSettings.port);
        } catch (error) {
            if (this.isPortInUseError(error)) {
                await this.handlePortInUse(serverSettings.port);
                return;
            }

            this.mode = "stopped";
            throw error;
        }
    }

    private async stopInternal(): Promise<void> {
        this.stopHeartbeatTimer();
        this.stopObserverTimer();

        if (!this.server) {
            this.server = undefined;
            this.port = undefined;
            if (this.mode !== "disabled") {
                this.mode = "stopped";
            }
            return;
        }

        const server: http.Server = this.server;
        this.server = undefined;
        this.port = undefined;

        await new Promise<void>((resolve: () => void) => {
            server.close(() => resolve());
        });

        await globalState.clearAuthSyncOwner(this.windowId);
        this.mode = "stopped";
        leetCodeChannel.appendLine("[auth-sync] Server stopped.");
    }

    private async forceStartInternal(): Promise<AuthSyncForceStartResult> {
        const serverSettings: IAuthSyncServerSettings = this.getServerSettings();

        if (!serverSettings.enabled) {
            return { kind: "disabled", port: serverSettings.port };
        }

        await this.stopInternal();

        const probe: AuthSyncPortProbe = await this.probePort(serverSettings.port);
        if (probe.kind === "free") {
            await this.startInternal();
            if (this.isRunning()) {
                return { kind: "started", port: serverSettings.port };
            }

            const startConflict: IAuthSyncPortConflict = await describePortOwner(serverSettings.port);
            return { kind: "portConflict", port: serverSettings.port, conflict: startConflict };
        }

        if (probe.kind === "authSync") {
            const previousOwner: AuthSyncOwnerInfo = probe.health.owner;
            const releaseResult: IReleaseResult = await this.requestOwnerRelease(serverSettings.port, previousOwner);
            if (!releaseResult.ok) {
                this.mode = "observer";
                this.port = serverSettings.port;
                this.lastConflict = undefined;
                this.observedOwner = previousOwner;
                this.startObserverTimer();
                return {
                    kind: "releaseFailed",
                    port: serverSettings.port,
                    owner: previousOwner,
                    message: releaseResult.message || "The owner window did not release the auth sync listener.",
                };
            }

            const released: boolean = await this.waitForPortRelease(serverSettings.port);
            if (!released) {
                const postReleaseProbe: AuthSyncPortProbe = await this.probePort(serverSettings.port);
                if (postReleaseProbe.kind === "occupied") {
                    const releaseConflict: IAuthSyncPortConflict = await describePortOwner(serverSettings.port);
                    return { kind: "portConflict", port: serverSettings.port, conflict: releaseConflict };
                }

                if (postReleaseProbe.kind === "authSync") {
                    this.mode = "observer";
                    this.port = serverSettings.port;
                    this.lastConflict = undefined;
                    this.observedOwner = postReleaseProbe.health.owner;
                    this.startObserverTimer();
                }

                return {
                    kind: "releaseFailed",
                    port: serverSettings.port,
                    owner: previousOwner,
                    message: `The owner window did not release port ${serverSettings.port} within ${FORCE_RELEASE_TIMEOUT_MS / 1000} seconds.`,
                };
            }

            await this.startInternal();
            if (!this.isRunning()) {
                const claimConflict: IAuthSyncPortConflict = await describePortOwner(serverSettings.port);
                return { kind: "portConflict", port: serverSettings.port, conflict: claimConflict };
            }

            return { kind: "claimed", port: serverSettings.port, previousOwner };
        }

        const conflict: IAuthSyncPortConflict = await describePortOwner(serverSettings.port);
        this.mode = "conflict";
        this.port = serverSettings.port;
        this.lastConflict = conflict;
        this.startObserverTimer();
        return { kind: "portConflict", port: serverSettings.port, conflict };
    }

    private async listenLocal(port: number): Promise<void> {
        const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
            this.handleRequest(req, res).catch((error: Error) => {
                if (isAuthSyncRequestError(error)) {
                    this.sendJson(res, error.statusCode, { ok: false, error: error.message });
                    return;
                }

                leetCodeChannel.appendLine(`[auth-sync] ${String(error)}`);
                this.sendJson(res, 500, { ok: false, error: "Internal server error." });
            });
        });

        this.server = server;

        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            const onError = (error: Error): void => {
                server.off("error", onError);
                this.server = undefined;
                this.port = undefined;
                reject(error);
            };

            server.once("error", onError);
            server.listen(port, HOST, () => {
                server.off("error", onError);
                this.mode = "local";
                this.port = port;
                this.lastConflict = undefined;
                this.observedOwner = undefined;
                leetCodeChannel.appendLine(`[auth-sync] Listening on http://${HOST}:${port}`);
                resolve();
            });
        });

        await this.writeOwnerHeartbeat();
        this.startHeartbeatTimer();
        this.stopObserverTimer();
    }

    private async handlePortInUse(port: number): Promise<void> {
        const probe: AuthSyncPortProbe = await this.probePort(port);

        if (probe.kind === "authSync") {
            this.mode = "observer";
            this.port = port;
            this.lastConflict = undefined;
            this.observedOwner = probe.health.owner;
            this.startObserverTimer();
            this.observeSharedAuthSyncState();
            leetCodeChannel.appendLine(`[auth-sync] Port ${port} is owned by another VS Code window: ${this.describeOwner(probe.health.owner)}.`);
            return;
        }

        this.mode = "conflict";
        this.port = port;
        this.lastConflict = await describePortOwner(port);
        this.startObserverTimer();
        leetCodeChannel.appendLine(`[auth-sync] Port ${port} is already in use by another program.`);
    }

    private async refreshStatusInternal(): Promise<void> {
        const serverSettings: IAuthSyncServerSettings = this.getServerSettings();

        if (!serverSettings.enabled) {
            if (this.server) {
                await this.stopInternal();
            }
            this.mode = "disabled";
            this.port = serverSettings.port;
            this.lastConflict = undefined;
            this.observedOwner = undefined;
            return;
        }

        if (this.mode === "local" && this.server && this.port === serverSettings.port) {
            return;
        }

        const probe: AuthSyncPortProbe = await this.probePort(serverSettings.port);
        if (probe.kind === "authSync") {
            this.mode = "observer";
            this.port = serverSettings.port;
            this.lastConflict = undefined;
            this.observedOwner = probe.health.owner;
            this.startObserverTimer();
            this.observeSharedAuthSyncState();
            return;
        }

        if (probe.kind === "free") {
            this.mode = "vacant";
            this.port = serverSettings.port;
            this.lastConflict = undefined;
            this.observedOwner = undefined;
            this.startObserverTimer();
            return;
        }

        this.mode = "conflict";
        this.port = serverSettings.port;
        this.observedOwner = undefined;
        this.lastConflict = await describePortOwner(serverSettings.port);
        this.startObserverTimer();
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url: URL = new URL(req.url || "/", `http://${HOST}`);

        if (req.method === "GET" && url.pathname === HEALTH_PATH) {
            this.handleHealth(res);
            return;
        }

        if (req.method === "POST" && url.pathname === RELEASE_PATH) {
            this.handleRelease(req, res);
            return;
        }

        if (req.method === "OPTIONS") {
            this.handleOptions(res);
            return;
        }

        if (req.method !== "POST" || url.pathname !== "/auth/update") {
            this.sendJson(res, 404, { ok: false, error: "Not found." });
            return;
        }

        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const secret: string = config.get<string>("authSync.secret", "");

        if (secret) {
            const headerValue: string | string[] | undefined = req.headers[SECRET_HEADER];
            const providedSecret: string | undefined = Array.isArray(headerValue) ? headerValue[0] : headerValue;
            if (providedSecret !== secret) {
                this.sendJson(res, 401, { ok: false, error: "Invalid auth sync secret." });
                return;
            }
        }

        const body: IAuthSyncRequestBody = await this.readJsonBody(req);
        const cookie: string = typeof body.cookie === "string" ? body.cookie.trim() : "";
        const browserUserAgent: string | undefined = this.getBrowserUserAgent(req, body);
        const browserRequestHeaders: IBrowserRequestHeaders | undefined = this.getBrowserRequestHeaders(body);

        if (!this.hasLeetCodeSessionCookie(cookie)) {
            this.sendJson(res, 400, { ok: false, error: "Request did not include a valid LeetCode login session cookie." });
            return;
        }

        this.logCookieUpdate(cookie, body.reason);
        if (browserUserAgent) {
            leetCodeChannel.appendLine("[auth-sync] Captured browser user agent for direct judge requests.");
        }
        if (browserRequestHeaders && Object.keys(browserRequestHeaders).length > 0) {
            leetCodeChannel.appendLine(`[auth-sync] Captured ${Object.keys(browserRequestHeaders).length} browser request headers for direct judge requests.`);
        }
        if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
            await leetCodeManager.updateSessionFromCookie(cookie, browserUserAgent, browserRequestHeaders);
        } else {
            await leetCodeManager.updateSyncedBrowserData(cookie, browserUserAgent, browserRequestHeaders);
        }
        await globalState.setAuthSyncLastSyncedAt(Date.now());

        this.sendJson(res, 200, { ok: true, message: "LeetCode cookie synced." });
    }

    private handleHealth(res: http.ServerResponse): void {
        this.sendJson(res, 200, {
            ok: true,
            service: AUTH_SYNC_SERVICE,
            host: HOST,
            port: this.port,
            mode: this.mode,
            owner: this.toPublicOwnerRecord(this.getCurrentOwnerRecord(Date.now())),
        }, false);
    }

    private handleRelease(req: http.IncomingMessage, res: http.ServerResponse): void {
        const headerValue: string | string[] | undefined = req.headers[CONTROL_HEADER];
        const providedToken: string | undefined = Array.isArray(headerValue) ? headerValue[0] : headerValue;

        if (!providedToken || providedToken !== this.controlToken) {
            this.sendJson(res, 403, { ok: false, error: "Invalid auth sync control token." }, false);
            return;
        }

        this.sendJson(res, 200, { ok: true, message: "Auth sync listener released." }, false);
        setTimeout(() => void this.releaseToObserver(), 50);
    }

    private handleOptions(res: http.ServerResponse): void {
        res.statusCode = 204;
        this.setCorsHeaders(res);
        res.end();
    }

    private readJsonBody(req: http.IncomingMessage): Promise<IAuthSyncRequestBody> {
        return new Promise<IAuthSyncRequestBody>((resolve: (body: IAuthSyncRequestBody) => void, reject: (error: Error) => void) => {
            let size: number = 0;
            let data: string = "";
            let rejected: boolean = false;

            req.on("data", (chunk: Buffer) => {
                if (rejected) {
                    return;
                }

                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    rejected = true;
                    reject(createAuthSyncRequestError(413, "Request body too large."));
                    req.resume();
                    return;
                }

                data += chunk.toString("utf8");
            });

            req.on("end", () => {
                if (rejected) {
                    return;
                }

                try {
                    resolve(JSON.parse(data || "{}") as IAuthSyncRequestBody);
                } catch (error) {
                    reject(createAuthSyncRequestError(400, "Invalid JSON request body."));
                }
            });

            req.on("error", reject);
        });
    }

    private hasLeetCodeSessionCookie(cookie: string): boolean {
        if (!cookie) {
            return false;
        }

        const sessionCookie: string | undefined = this.getCookieValue(cookie, "LEETCODE_SESSION");
        return this.hasUsableCookieToken(sessionCookie);
    }

    private getCookieValue(cookie: string, name: string): string | undefined {
        for (const part of cookie.split(";")) {
            const trimmed: string = part.trim();
            const separatorIndex: number = trimmed.indexOf("=");

            if (separatorIndex <= 0) {
                continue;
            }

            if (trimmed.slice(0, separatorIndex) === name) {
                return trimmed.slice(separatorIndex + 1);
            }
        }

        return undefined;
    }

    private getBrowserUserAgent(req: http.IncomingMessage, body: IAuthSyncRequestBody): string | undefined {
        if (typeof body.userAgent === "string" && body.userAgent.trim()) {
            return body.userAgent.trim();
        }

        const headerValue: string | string[] | undefined = req.headers["user-agent"];
        const userAgent: string | undefined = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        return userAgent && userAgent.trim() ? userAgent.trim() : undefined;
    }

    private getBrowserRequestHeaders(body: IAuthSyncRequestBody): IBrowserRequestHeaders | undefined {
        if (!body.requestHeaders || typeof body.requestHeaders !== "object" || Array.isArray(body.requestHeaders)) {
            return undefined;
        }

        const headers: IBrowserRequestHeaders = {};
        const rawHeaders: { [key: string]: unknown } = body.requestHeaders as { [key: string]: unknown };
        for (const key of Object.keys(rawHeaders)) {
            const normalizedKey: string = key.toLowerCase();
            const value: unknown = rawHeaders[key];
            if (!this.isReplayableLeetCodeHeader(normalizedKey) || typeof value !== "string") {
                continue;
            }

            headers[normalizedKey] = value;
        }

        return Object.keys(headers).length > 0 ? headers : undefined;
    }

    private isReplayableLeetCodeHeader(name: string): boolean {
        return [
            "accept",
            "accept-language",
            "authorization",
            "connection",
            "dnt",
            "priority",
            "sec-ch-ua",
            "sec-ch-ua-arch",
            "sec-ch-ua-bitness",
            "sec-ch-ua-full-version",
            "sec-ch-ua-full-version-list",
            "sec-ch-ua-mobile",
            "sec-ch-ua-model",
            "sec-ch-ua-platform",
            "sec-ch-ua-platform-version",
            "sec-fetch-dest",
            "sec-fetch-mode",
            "sec-fetch-site",
            "sec-gpc",
            "te",
            "user-agent",
        ].indexOf(name) >= 0;
    }

    private hasUsableCookieToken(value: string | undefined): boolean {
        if (!value) {
            return false;
        }

        const token: string = value.trim();
        return !!token && token !== "null" && token !== "undefined" && token !== "deleted";
    }

    private logCookieUpdate(cookie: string, reason: string | undefined): void {
        const names: string = cookie
            .split(";")
            .map((part: string) => part.trim().split("=")[0])
            .filter((name: string) => !!name)
            .join(", ");
        const safeReason: string = typeof reason === "string" && reason ? reason : "unspecified";

        leetCodeChannel.appendLine(`[auth-sync] Received cookie update. Cookie names: ${names}. Reason: ${safeReason}.`);
    }

    private sendJson(res: http.ServerResponse, status: number, payload: object, allowCors: boolean = true): void {
        if (res.headersSent) {
            return;
        }

        res.statusCode = status;
        if (allowCors) {
            this.setCorsHeaders(res);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
    }

    private setCorsHeaders(res: http.ServerResponse): void {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-LeetCode-AuthSync-Secret");
    }

    private startHeartbeatTimer(): void {
        this.stopHeartbeatTimer();
        const settings: IAuthSyncOwnershipSettings = this.getOwnershipSettings();
        this.heartbeatTimer = setInterval(() => {
            void this.writeOwnerHeartbeat().catch((error: Error) => {
                leetCodeChannel.appendLine(`[auth-sync] Failed to write owner heartbeat: ${String(error)}`);
            });
        }, settings.heartbeatMs);
    }

    private stopHeartbeatTimer(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private startObserverTimer(): void {
        this.stopObserverTimer();
        const settings: IAuthSyncOwnershipSettings = this.getOwnershipSettings();
        this.observerTimer = setInterval(() => {
            void this.runObserverCheck().catch((error: Error) => {
                leetCodeChannel.appendLine(`[auth-sync] Observer check failed: ${String(error)}`);
            });
        }, settings.observerCheckMs);
    }

    private stopObserverTimer(): void {
        if (this.observerTimer) {
            clearInterval(this.observerTimer);
            this.observerTimer = undefined;
        }
    }

    private async runObserverCheck(): Promise<void> {
        if (this.observerCheckInFlight || this.mode === "local" || this.mode === "disabled") {
            return;
        }

        this.observerCheckInFlight = true;
        try {
            this.observeSharedAuthSyncState();

            const serverSettings: IAuthSyncServerSettings = this.getServerSettings();
            if (!serverSettings.enabled) {
                return;
            }

            const probe: AuthSyncPortProbe = await this.probePort(serverSettings.port);
            if (probe.kind === "free") {
                leetCodeChannel.appendLine(`[auth-sync] No live auth sync owner found. Trying to become owner on port ${serverSettings.port}.`);
                await this.enqueue(() => this.startInternal());
            } else if (probe.kind === "authSync") {
                this.mode = "observer";
                this.port = serverSettings.port;
                this.lastConflict = undefined;
                this.observedOwner = probe.health.owner;
            } else {
                this.mode = "conflict";
                this.port = serverSettings.port;
                this.observedOwner = undefined;
            }
        } finally {
            this.observerCheckInFlight = false;
        }
    }

    private releaseToObserver(): Promise<void> {
        return this.enqueue(async () => {
            const releasedPort: number = this.port || this.getServerSettings().port;
            await this.stopInternal();

            const serverSettings: IAuthSyncServerSettings = this.getServerSettings();
            if (!serverSettings.enabled || serverSettings.port !== releasedPort) {
                return;
            }

            const owner: IAuthSyncOwnerRecord | undefined = globalState.getAuthSyncOwner();
            this.mode = "observer";
            this.port = releasedPort;
            this.lastConflict = undefined;
            this.observedOwner = owner ? this.toPublicOwnerRecord(owner) : undefined;
            this.startObserverTimer();
            this.observeSharedAuthSyncState();
            leetCodeChannel.appendLine(`[auth-sync] Listener released. This window is now observing port ${releasedPort}.`);
        });
    }

    private observeSharedAuthSyncState(): void {
        const lastSyncedAt: number | undefined = globalState.getAuthSyncLastSyncedAt();
        if (!lastSyncedAt || lastSyncedAt === this.lastObservedAuthSyncAt) {
            return;
        }

        this.lastObservedAuthSyncAt = lastSyncedAt;
    }

    private async writeOwnerHeartbeat(): Promise<void> {
        if (!this.server || this.mode !== "local" || !this.port) {
            return;
        }

        const owner: IAuthSyncOwnerRecord = this.getCurrentOwnerRecord(Date.now());
        this.observedOwner = this.toPublicOwnerRecord(owner);
        await globalState.setAuthSyncOwner(owner);
    }

    private getCurrentOwnerRecord(heartbeatAt: number): IAuthSyncOwnerRecord {
        return {
            service: AUTH_SYNC_SERVICE,
            windowId: this.windowId,
            windowLabel: this.getWindowLabel(),
            pid: process.pid,
            port: this.port || DEFAULT_PORT,
            startedAt: this.startedAt,
            heartbeatAt,
            controlToken: this.controlToken,
        };
    }

    private getCurrentWindowIdentity(): IAuthSyncWindowIdentity {
        return {
            windowId: this.windowId,
            windowLabel: this.getWindowLabel(),
            pid: process.pid,
            startedAt: this.startedAt,
        };
    }

    private getWindowLabel(): string {
        if (vscode.workspace.name) {
            return vscode.workspace.name;
        }

        const folders: readonly vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders.map((folder: vscode.WorkspaceFolder) => path.basename(folder.uri.fsPath)).join(", ");
        }

        return "Untitled VS Code window";
    }

    private getServerSettings(): IAuthSyncServerSettings {
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const enabled: boolean = config.get<boolean>("authSync.enabled", true);
        const configuredPort: number = config.get<number>("authSync.port", DEFAULT_PORT);
        return {
            enabled,
            port: this.normalizePort(configuredPort),
        };
    }

    private getOwnershipSettings(): IAuthSyncOwnershipSettings {
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const heartbeatSeconds: number = this.normalizeSeconds(
            config.get<number>("authSync.ownerHeartbeatIntervalSeconds", DEFAULT_HEARTBEAT_SECONDS),
            DEFAULT_HEARTBEAT_SECONDS,
            10,
            3600
        );
        const observerCheckSeconds: number = this.normalizeSeconds(
            config.get<number>("authSync.observerCheckIntervalSeconds", DEFAULT_OBSERVER_CHECK_SECONDS),
            DEFAULT_OBSERVER_CHECK_SECONDS,
            15,
            3600
        );
        const heartbeatMs: number = heartbeatSeconds * 1000;
        const observerCheckMs: number = observerCheckSeconds * 1000;

        return { heartbeatMs, observerCheckMs };
    }

    private normalizeSeconds(value: number | undefined, defaultValue: number, min: number, max: number): number {
        if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
            return Math.floor(value);
        }

        return defaultValue;
    }

    private normalizePort(port: number): number {
        if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
            return port;
        }

        return DEFAULT_PORT;
    }

    private isPortInUseError(error: Error): boolean {
        return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    }

    private probePort(port: number): Promise<AuthSyncPortProbe> {
        return new Promise<AuthSyncPortProbe>((resolve: (probe: AuthSyncPortProbe) => void) => {
            let resolved: boolean = false;
            const finish = (probe: AuthSyncPortProbe): void => {
                if (!resolved) {
                    resolved = true;
                    resolve(probe);
                }
            };

            const req: http.ClientRequest = http.request(
                {
                    host: HOST,
                    port,
                    path: HEALTH_PATH,
                    method: "GET",
                    timeout: 1500,
                },
                (res: http.IncomingMessage) => {
                    let data: string = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        if (data.length < 16 * 1024) {
                            data += chunk;
                        }
                    });
                    res.on("end", () => {
                        try {
                            const body: IAuthSyncHealthResponse = JSON.parse(data || "{}") as IAuthSyncHealthResponse;
                            if (res.statusCode === 200 && body.service === AUTH_SYNC_SERVICE && body.owner && body.owner.windowId && body.owner.port === port) {
                                finish({ kind: "authSync", health: body });
                                return;
                            }
                        } catch (error) {
                            // Non-JSON health responses are treated as unrelated listeners.
                        }

                        finish({ kind: "occupied" });
                    });
                }
            );

            req.on("timeout", () => {
                req.destroy(new Error("Timed out while probing auth sync health."));
            });
            req.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code === "ECONNREFUSED") {
                    finish({ kind: "free" });
                    return;
                }

                finish({ kind: "occupied" });
            });
            req.end();
        });
    }

    private requestOwnerRelease(port: number, owner: AuthSyncOwnerInfo): Promise<IReleaseResult> {
        const currentOwner: IAuthSyncOwnerRecord | undefined = globalState.getAuthSyncOwner();
        if (!currentOwner || currentOwner.windowId !== owner.windowId || !currentOwner.controlToken) {
            return Promise.resolve({
                ok: false,
                message: `Could not find a valid control token for owner window ${this.describeOwner(owner)}.`,
            });
        }

        return new Promise<IReleaseResult>((resolve: (result: IReleaseResult) => void) => {
            let resolved: boolean = false;
            const finish = (result: IReleaseResult): void => {
                if (!resolved) {
                    resolved = true;
                    resolve(result);
                }
            };

            const req: http.ClientRequest = http.request(
                {
                    host: HOST,
                    port,
                    path: RELEASE_PATH,
                    method: "POST",
                    timeout: 3000,
                    headers: {
                        [CONTROL_HEADER]: currentOwner.controlToken,
                    },
                },
                (res: http.IncomingMessage) => {
                    let data: string = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        data += chunk;
                    });
                    res.on("end", () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            finish({ ok: true });
                            return;
                        }

                        finish({
                            ok: false,
                            message: `Owner window rejected release request with HTTP ${res.statusCode || "unknown"}: ${data}`,
                        });
                    });
                }
            );

            req.on("timeout", () => {
                req.destroy(new Error("Timed out while asking owner window to release auth sync port."));
            });
            req.on("error", (error: Error) => {
                finish({ ok: false, message: String(error) });
            });
            req.end();
        });
    }

    private async waitForPortRelease(port: number): Promise<boolean> {
        const startedAt: number = Date.now();
        while (Date.now() - startedAt < FORCE_RELEASE_TIMEOUT_MS) {
            await this.delay(250);
            const probe: AuthSyncPortProbe = await this.probePort(port);
            if (probe.kind === "free") {
                return true;
            }
        }

        return false;
    }

    private delay(ms: number): Promise<void> {
        return new Promise<void>((resolve: () => void) => setTimeout(resolve, ms));
    }

    private describeOwner(owner: AuthSyncOwnerInfo | IAuthSyncOwnerRecord | undefined): string {
        if (!owner) {
            return "unknown owner";
        }

        return `${owner.windowLabel} (PID ${owner.pid}, window ${owner.windowId})`;
    }

    private getSnapshotOwner(): AuthSyncOwnerInfo | undefined {
        if (this.mode === "local" && this.server) {
            return this.toPublicOwnerRecord(this.getCurrentOwnerRecord(Date.now()));
        }

        return this.observedOwner;
    }

    private toPublicOwnerRecord(owner: IAuthSyncOwnerRecord): AuthSyncOwnerInfo {
        return {
            service: owner.service,
            windowId: owner.windowId,
            windowLabel: owner.windowLabel,
            pid: owner.pid,
            port: owner.port,
            startedAt: owner.startedAt,
            heartbeatAt: owner.heartbeatAt,
        };
    }
}

function createAuthSyncRequestError(statusCode: number, message: string): IAuthSyncRequestError {
    const error: IAuthSyncRequestError = new Error(message) as IAuthSyncRequestError;
    error.statusCode = statusCode;
    return error;
}

function isAuthSyncRequestError(error: Error): error is IAuthSyncRequestError {
    return typeof (error as IAuthSyncRequestError).statusCode === "number";
}

interface IAuthSyncServerSettings {
    enabled: boolean;
    port: number;
}

interface IAuthSyncRequestError extends Error {
    statusCode: number;
}

interface IAuthSyncRequestBody {
    cookie?: unknown;
    reason?: string;
    requestHeaders?: unknown;
    userAgent?: unknown;
}

interface IAuthSyncHealthResponse {
    ok: boolean;
    service: string;
    host: string;
    port: number;
    mode: AuthSyncServerMode;
    owner: AuthSyncOwnerInfo;
}

type AuthSyncPortProbe =
    | { kind: "free" }
    | { kind: "authSync"; health: IAuthSyncHealthResponse }
    | { kind: "occupied" };

interface IReleaseResult {
    ok: boolean;
    message?: string;
}

export const authSyncServer: AuthSyncServer = new AuthSyncServer();
