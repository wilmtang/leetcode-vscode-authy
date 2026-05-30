// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as http from "http";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";

const DEFAULT_PORT: number = 17899;
const HOST: string = "127.0.0.1";
const MAX_BODY_BYTES: number = 64 * 1024;
const SECRET_HEADER: string = "x-leetcode-authsync-secret";

class AuthSyncServer implements vscode.Disposable {
    private server: http.Server | undefined;
    private port: number | undefined;
    private pending: Promise<void> = Promise.resolve();

    public start(): Promise<void> {
        this.pending = this.pending.then(() => this.startInternal(), () => this.startInternal());
        return this.pending;
    }

    public stop(): Promise<void> {
        this.pending = this.pending.then(() => this.stopInternal(), () => this.stopInternal());
        return this.pending;
    }

    public isRunning(): boolean {
        return !!this.server;
    }

    public getPort(): number | undefined {
        return this.port;
    }

    public dispose(): void {
        void this.stop();
    }

    private async startInternal(): Promise<void> {
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const enabled: boolean = config.get<boolean>("authSync.enabled", true);
        const configuredPort: number = config.get<number>("authSync.port", DEFAULT_PORT);
        const port: number = this.normalizePort(configuredPort);

        if (!enabled) {
            await this.stopInternal();
            leetCodeChannel.appendLine("[auth-sync] Server is disabled.");
            return;
        }

        if (this.server && this.port === port) {
            return;
        }

        await this.stopInternal();

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
                this.port = port;
                leetCodeChannel.appendLine(`[auth-sync] Listening on http://${HOST}:${port}`);
                resolve();
            });
        });
    }

    private async stopInternal(): Promise<void> {
        if (!this.server) {
            return;
        }

        const server: http.Server = this.server;
        this.server = undefined;
        this.port = undefined;

        await new Promise<void>((resolve: () => void) => {
            server.close(() => resolve());
        });

        leetCodeChannel.appendLine("[auth-sync] Server stopped.");
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url: URL = new URL(req.url || "/", `http://${HOST}`);

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

        if (!this.hasLeetCodeSessionCookie(cookie)) {
            this.sendJson(res, 400, { ok: false, error: "Request did not include a valid LeetCode login session cookie." });
            return;
        }

        this.logCookieUpdate(cookie, body.reason);
        await leetCodeManager.updateSessionFromCookie(cookie);

        this.sendJson(res, 200, { ok: true, message: "LeetCode cookie synced." });
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

    private sendJson(res: http.ServerResponse, status: number, payload: object): void {
        if (res.headersSent) {
            return;
        }

        res.statusCode = status;
        this.setCorsHeaders(res);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
    }

    private setCorsHeaders(res: http.ServerResponse): void {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-LeetCode-AuthSync-Secret");
    }

    private normalizePort(port: number): number {
        if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
            return port;
        }

        return DEFAULT_PORT;
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

interface IAuthSyncRequestError extends Error {
    statusCode: number;
}

interface IAuthSyncRequestBody {
    cookie?: unknown;
    reason?: string;
}

export const authSyncServer: AuthSyncServer = new AuthSyncServer();
