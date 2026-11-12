import * as assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";
import * as vscode from "vscode";
import {
    isCloudflareChallengeError,
    isRateLimitedError,
    RATE_LIMITED_MESSAGE,
    RateLimitedError,
    requestJson,
} from "../../request/leetcode-http";
import { redactDiagnostic, reportCommandError } from "../../utils/uiUtils";

const CHALLENGE_HTML: string = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>";

describe("LeetCode rate limit handling", () => {
    it("classifies a plain 429 from axios as a rate limit without a curl replay", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Too Many Requests" }));
        });
        await listen(server);
        try {
            await assert.rejects(
                requestJson({ method: "POST", url: `${origin(server)}/submit/`, data: {} }, { label: "submit enqueue" }),
                (error: unknown) => {
                    assert.ok(isRateLimitedError(error), String(error));
                    assert.strictEqual((error as RateLimitedError).label, "submit enqueue");
                    assert.strictEqual((error as Error).message, RATE_LIMITED_MESSAGE);
                    return true;
                },
            );
            assert.strictEqual(hits, 1, "a 429 must not be replayed through curl");
        } finally {
            await close(server);
        }
    });

    it("still treats a 429 challenge page as a Cloudflare challenge", async () => {
        const server: http.Server = http.createServer((_req, res) => {
            res.writeHead(429, { "Content-Type": "text/html" });
            res.end(CHALLENGE_HTML);
        });
        await listen(server);
        try {
            await assert.rejects(
                requestJson({ method: "GET", url: `${origin(server)}/check` }, { label: "challenge 429" }),
                (error: unknown) => isCloudflareChallengeError(error) && !isRateLimitedError(error),
            );
        } finally {
            await close(server);
        }
    });

    it("classifies a 429 on the curl replay as a rate limit", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            if (hits === 1) {
                res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
                res.end(CHALLENGE_HTML);
                return;
            }
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end("{}");
        });
        await listen(server);
        try {
            await assert.rejects(
                requestJson({ method: "GET", url: `${origin(server)}/check` }, { label: "curl 429" }),
                (error: unknown) => isRateLimitedError(error),
            );
            assert.strictEqual(hits, 2);
        } finally {
            await close(server);
        }
    });

    it("shows the rate-limit explanation instead of the generic failure toast", async () => {
        const shown: string[] = [];
        const original = vscode.window.showErrorMessage;
        (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
            shown.push(message);
            return Promise.resolve(undefined);
        };
        try {
            await reportCommandError("Submit solution", new RateLimitedError("submit enqueue"), "Failed to submit the solution. Please open the output channel for details.");
            await reportCommandError("Submit solution", new Error("boom"), "Failed to submit the solution. Please open the output channel for details.");
        } finally {
            (vscode.window as { showErrorMessage: unknown }).showErrorMessage = original;
        }
        assert.deepStrictEqual(shown, [
            RATE_LIMITED_MESSAGE,
            "Failed to submit the solution. Please open the output channel for details.",
        ]);
    });

    it("logs a rate limit with its name and without request data", () => {
        const diagnostic: string = redactDiagnostic(new RateLimitedError("submit enqueue"));
        assert.ok(diagnostic.startsWith(`RateLimitedError: ${RATE_LIMITED_MESSAGE}`), diagnostic);
    });
});

function origin(server: http.Server): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function listen(server: http.Server): Promise<void> {
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}
