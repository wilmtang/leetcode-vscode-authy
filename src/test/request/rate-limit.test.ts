import * as assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";
import * as vscode from "vscode";
import {
    enqueueWithBackoff,
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

    it("re-sends an enqueue that LeetCode rate limited, then returns its task", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            if (hits <= 2) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ submission_id: 7 }));
        });
        await listen(server);
        try {
            const delays: number[] = [];
            const task = await enqueueWithBackoff<{ error?: string; submission_id?: number }>(
                "submit enqueue",
                "submit",
                () => requestJson({ method: "POST", url: `${origin(server)}/submit/`, data: {} }, { label: "submit enqueue" }),
                undefined,
                (attempt: number) => { delays.push(attempt); return 1; },
            );
            assert.strictEqual(task.submission_id, 7);
            assert.strictEqual(hits, 3);
            assert.deepStrictEqual(delays, [0, 1]);
        } finally {
            await close(server);
        }
    });

    it("re-sends a 200 too-soon body and stops after the attempt limit with a rate limit", async () => {
        let sends: number = 0;
        await assert.rejects(
            enqueueWithBackoff("run-code enqueue", "test", () => {
                sends++;
                return Promise.resolve({ error: "You have submitted too soon" });
            }, undefined, () => 1, 3),
            (error: unknown) => isRateLimitedError(error) && (error as RateLimitedError).label === "run-code enqueue",
        );
        assert.strictEqual(sends, 3);
    });

    it("returns any other error body to the caller without re-sending", async () => {
        let sends: number = 0;
        const task = await enqueueWithBackoff("submit enqueue", "submit", () => {
            sends++;
            return Promise.resolve({ error: "Your session has expired" });
        }, undefined, () => 1);
        assert.strictEqual(task.error, "Your session has expired");
        assert.strictEqual(sends, 1);
    });

    it("never re-sends a failure that may have reached the judge", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end("{}");
        });
        await listen(server);
        try {
            await assert.rejects(
                enqueueWithBackoff("submit enqueue", "submit",
                    () => requestJson({ method: "POST", url: `${origin(server)}/submit/`, data: {} }, { label: "submit enqueue" }),
                    undefined, () => 1),
                (error: unknown) => !isRateLimitedError(error) && /code=500/.test(String(error)),
            );
            assert.strictEqual(hits, 1);
        } finally {
            await close(server);
        }
    });

    it("stops re-sending when cancelled during the back-off", async () => {
        let sends: number = 0;
        let cancelled: boolean = false;
        await assert.rejects(
            enqueueWithBackoff("submit enqueue", "submit", () => {
                sends++;
                cancelled = true;
                return Promise.reject(new RateLimitedError("submit enqueue"));
            }, () => cancelled, () => 5000),
            (error: unknown) => (error as Error).name === "OperationCancelledError",
        );
        assert.strictEqual(sends, 1);
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
