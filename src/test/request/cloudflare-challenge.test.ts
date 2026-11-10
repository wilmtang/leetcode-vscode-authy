import * as assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";
import * as vscode from "vscode";
import { globalState, UserDataType } from "../../globalState";
import { captureAuthRequest } from "../../request/authRequest";
import { ClearanceOutcome, IClearanceState, watchForFreshClearance } from "../../commands/cloudflareRecovery";
import { CloudflareChallengeError, DirectApiUnsupportedError, isCloudflareChallengeError, requestJson, withChallengeBackoff } from "../../request/leetcode-http";

const CHALLENGE_HTML: string = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>";

describe("Cloudflare challenge handling", () => {
    it("classifies a non-403 challenge from both axios and curl as a typed challenge", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            res.writeHead(503, { "Content-Type": "text/html" });
            res.end(CHALLENGE_HTML);
        });
        await listen(server);
        try {
            const port: number = (server.address() as AddressInfo).port;
            await assert.rejects(
                requestJson({ method: "GET", url: `http://127.0.0.1:${port}/check` }, { label: "challenge 503" }),
                (error: unknown) => {
                    assert.ok(isCloudflareChallengeError(error), String(error));
                    assert.ok(error instanceof DirectApiUnsupportedError);
                    assert.strictEqual((error as Error).name, "CloudflareChallengeError");
                    return true;
                },
            );
            assert.strictEqual(hits, 2, "axios must fall back to curl exactly once");
        } finally {
            await close(server);
        }
    });

    it("classifies a 200 challenge page from curl as a challenge", async () => {
        let hits: number = 0;
        const server: http.Server = http.createServer((_req, res) => {
            hits++;
            // First (axios) gets the header; the curl replay gets a 200 HTML challenge.
            res.writeHead(hits === 1 ? 403 : 200, hits === 1 ? { "cf-mitigated": "challenge" } : { "Content-Type": "text/html" });
            res.end(CHALLENGE_HTML);
        });
        await listen(server);
        try {
            const port: number = (server.address() as AddressInfo).port;
            await assert.rejects(
                requestJson({ method: "GET", url: `http://127.0.0.1:${port}/check` }, { label: "challenge 200" }),
                (error: unknown) => isCloudflareChallengeError(error),
            );
        } finally {
            await close(server);
        }
    });

    it("never treats a JSON response that echoes the challenge title as a challenge", async () => {
        const server: http.Server = http.createServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ interpret_id: "run-1", test_case: "<title>Just a moment...</title> cf-mitigated" }));
        });
        await listen(server);
        try {
            const port: number = (server.address() as AddressInfo).port;
            const data = await requestJson<{ interpret_id: string }>({ method: "POST", url: `http://127.0.0.1:${port}/enqueue`, data: {} }, { label: "echo" });
            assert.strictEqual(data.interpret_id, "run-1");
        } finally {
            await close(server);
        }
    });

    it("treats the cf-mitigated response header as a challenge signal", async () => {
        const server: http.Server = http.createServer((_req, res) => {
            res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
            res.end(CHALLENGE_HTML);
        });
        await listen(server);
        try {
            const port: number = (server.address() as AddressInfo).port;
            await assert.rejects(
                requestJson({ method: "GET", url: `http://127.0.0.1:${port}/check` }, { label: "challenge header" }),
                (error: unknown) => isCloudflareChallengeError(error),
            );
        } finally {
            await close(server);
        }
    });

    it("retries a challenged call exactly once and never retries other failures", async () => {
        let calls: number = 0;
        const value: string = await withChallengeBackoff("unit", async () => {
            calls++;
            if (calls === 1) {
                throw new CloudflareChallengeError("challenged");
            }
            return "ok";
        }, undefined, 1);
        assert.strictEqual(value, "ok");
        assert.strictEqual(calls, 2);

        calls = 0;
        await assert.rejects(withChallengeBackoff("unit", async () => {
            calls++;
            throw new CloudflareChallengeError("still challenged");
        }, undefined, 1), /still challenged/);
        assert.strictEqual(calls, 2);

        calls = 0;
        await assert.rejects(withChallengeBackoff("unit", async () => {
            calls++;
            throw new Error("transport failure");
        }, undefined, 1), /transport failure/);
        assert.strictEqual(calls, 1, "non-challenge errors may have reached the judge and must not be re-sent");
    });

    describe("judge auth owner", () => {
        const identity: UserDataType = { isSignedIn: true, isPremium: false, username: "account-a", avatar: "" };

        async function initialize(): Promise<void> {
            const values: Map<string, unknown> = new Map<string, unknown>();
            const secrets: Map<string, string> = new Map<string, string>();
            await globalState.initialize({
                globalState: {
                    get: (key: string) => values.get(key),
                    update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
                },
                secrets: {
                    get: (key: string) => Promise.resolve(secrets.get(key)),
                    store: (key: string, value: string) => { secrets.set(key, value); return Promise.resolve(); },
                    delete: (key: string) => { secrets.delete(key); return Promise.resolve(); },
                    onDidChange: () => new vscode.Disposable(() => undefined),
                },
                subscriptions: [],
            } as unknown as vscode.ExtensionContext);
        }

        it("survives a same-account credential refresh but not an account change", async () => {
            await initialize();
            await globalState.setSignedInSession("LEETCODE_SESSION=a; csrftoken=a; cf_clearance=old", identity);
            const judge = captureAuthRequest(undefined, { sameAccount: true });
            const strict = captureAuthRequest();

            await globalState.updateSignedInSession("LEETCODE_SESSION=a; csrftoken=a; cf_clearance=new", "agent", { accept: "*/*" });
            assert.ok(strict.isCancelled(), "default owners stay revision-bound");
            assert.ok(!judge.isCancelled(), "a same-account browser sync must not drop a judge result");

            await globalState.setSignedInSession("LEETCODE_SESSION=b; csrftoken=b", { ...identity, username: "account-b" });
            assert.ok(judge.isCancelled());

            await globalState.setSignedOutSession(true);
            assert.ok(judge.isCancelled());
        });
    });

    describe("waiting for a fresh clearance", () => {
        function run(states: IClearanceState[], aborted: () => boolean = () => false, timeoutMs: number = 1000): Promise<ClearanceOutcome> {
            let index: number = 0;
            const read = () => states[Math.min(index++, states.length - 1)];
            return watchForFreshClearance("alice", "old", aborted, timeoutMs, 5, read).promise;
        }

        it("resolves when the same account syncs a different cf_clearance", async () => {
            assert.strictEqual(await run([
                { username: "alice", clearance: "old" },
                { username: "alice", clearance: "old" },
                { username: "alice", clearance: "new" },
            ]), "synced");
        });

        it("ignores syncs that keep the challenged clearance", async () => {
            assert.strictEqual(await run([{ username: "alice", clearance: "old" }], () => false, 50), "timeout");
        });

        it("stops when the account changes or the operation is superseded", async () => {
            assert.strictEqual(await run([{ username: "bob", clearance: "new" }]), "account-changed");
            assert.strictEqual(await run([{ username: "alice", clearance: "new" }], () => true), "superseded");
        });

        it("can be cancelled", async () => {
            const watcher = watchForFreshClearance("alice", "old", () => false, 1000, 5, () => ({ username: "alice", clearance: "old" }));
            watcher.dispose();
            assert.strictEqual(await watcher.promise, "cancelled");
        });
    });
});

function listen(server: http.Server): Promise<void> {
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}
