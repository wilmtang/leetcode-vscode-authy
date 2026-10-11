import * as assert from "assert";
import * as vscode from "vscode";
import { globalState, IAuthSessionSnapshot, UserDataType } from "../../globalState";
import { createHeaders } from "../../request/leetcode-http";

const authSessionKey: string = "leetcode-auth-session-v1";

class TestMemento {
    private readonly values: Map<string, unknown> = new Map<string, unknown>();

    public get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    public update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
        return Promise.resolve();
    }

    public seed(key: string, value: unknown): void {
        this.values.set(key, value);
    }
}

class TestSecretStorage {
    public readonly values: Map<string, string> = new Map<string, string>();
    public failNextStore: boolean = false;
    private readonly listeners: Array<(event: vscode.SecretStorageChangeEvent) => void> = [];

    public get(key: string): Promise<string | undefined> {
        return Promise.resolve(this.values.get(key));
    }

    public store(key: string, value: string): Promise<void> {
        if (this.failNextStore) {
            this.failNextStore = false;
            return Promise.reject(new Error("injected secret-store failure"));
        }
        this.values.set(key, value);
        this.fire(key);
        return Promise.resolve();
    }

    public delete(key: string): Promise<void> {
        this.values.delete(key);
        this.fire(key);
        return Promise.resolve();
    }

    public onDidChange(listener: (event: vscode.SecretStorageChangeEvent) => void): vscode.Disposable {
        this.listeners.push(listener);
        return new vscode.Disposable(() => undefined);
    }

    private fire(key: string): void {
        for (const listener of this.listeners) {
            listener({ key });
        }
    }
}

const identity: UserDataType = {
    isSignedIn: true,
    isPremium: false,
    username: "account-a",
    avatar: "",
};

function context(memento: TestMemento, secrets: TestSecretStorage): vscode.ExtensionContext {
    return {
        globalState: memento,
        secrets,
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

describe("atomic auth session storage", () => {
    it("does not resurrect a read captured before a durable sign-out", async () => {
        const secrets = new TestSecretStorage();
        await globalState.initialize(context(new TestMemento(), secrets));
        const old = await globalState.setSignedInSession("synthetic-a", identity);
        let release!: (value: string) => void;
        const staleRead = new Promise<string>((resolve) => release = resolve);
        const get = secrets.get.bind(secrets);
        let first = true;
        secrets.get = (key) => first ? (first = false, staleRead) : get(key);
        await secrets.store(authSessionKey, JSON.stringify(old));
        await globalState.setSignedOutSession(true);
        release(JSON.stringify(old));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(globalState.getAuthSession()!.state, "signed-out");
    });

    it("reconciles a sibling write delivered during a pending local store", async () => {
        const secrets = new TestSecretStorage();
        await globalState.initialize(context(new TestMemento(), secrets));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => release = resolve);
        const store = secrets.store.bind(secrets);
        secrets.store = async (key, value) => { await store(key, value); await gate; };
        const pending = globalState.setSignedInSession("synthetic-local", identity);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const remote = { version: 1, revision: 999, state: "signed-in", intentionalSignOut: false,
            cookie: "synthetic-remote", identity: { ...identity, username: "remote" } };
        await store(authSessionKey, JSON.stringify(remote));
        release();
        await assert.rejects(pending, /another window/);
        assert.strictEqual(globalState.getCookie(), "synthetic-remote");
    });

    it("notifies local credential changes and remote removal", async () => {
        const secrets = new TestSecretStorage();
        await globalState.initialize(context(new TestMemento(), secrets));
        const observed: IAuthSessionSnapshot[] = [];
        const subscription = globalState.onDidChangeAuthSession((snapshot) => observed.push(snapshot));
        await globalState.setSignedInSession("synthetic-a", identity);
        assert.strictEqual(observed[0].source, "local");
        await secrets.delete(authSessionKey);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(observed[1].state, "signed-out");
        assert.strictEqual(globalState.getCookie(), undefined);
        subscription.dispose();
    });
    it("migrates legacy credential fields into one complete secret record", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        memento.seed("leetcode-user-status", identity);
        secrets.values.set("leetcode-cookie", "LEETCODE_SESSION=a; csrftoken=a");
        secrets.values.set("leetcode-browser-user-agent", "agent-a");
        secrets.values.set("leetcode-browser-request-headers", JSON.stringify({ authorization: "Bearer a" }));

        await globalState.initialize(context(memento, secrets));

        const snapshot: IAuthSessionSnapshot | undefined = globalState.getAuthSession();
        assert.strictEqual(snapshot && snapshot.state, "signed-in");
        assert.strictEqual(snapshot && snapshot.identity && snapshot.identity.username, "account-a");
        assert.strictEqual(snapshot && snapshot.browserRequestHeaders && snapshot.browserRequestHeaders.authorization, "Bearer a");
        assert.ok(secrets.values.has(authSessionKey));
        assert.ok(!secrets.values.has("leetcode-cookie"));
        assert.strictEqual(memento.get("leetcode-user-status"), undefined);
    });

    it("keeps the old complete snapshot visible when replacement persistence fails", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        await globalState.initialize(context(memento, secrets));
        const oldSnapshot: IAuthSessionSnapshot = await globalState.setSignedInSession(
            "LEETCODE_SESSION=a; csrftoken=a",
            identity,
            "agent-a",
            { authorization: "Bearer a" },
        );
        secrets.failNextStore = true;

        await assert.rejects(globalState.setSignedOutSession(true), /injected secret-store failure/);

        assert.deepStrictEqual(globalState.getAuthSession(), oldSnapshot);
        assert.deepStrictEqual(JSON.parse(secrets.values.get(authSessionKey)!), oldSnapshot);
    });

    it("returns immutable request snapshots across account rotation", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        await globalState.initialize(context(memento, secrets));
        await globalState.setSignedInSession(
            "LEETCODE_SESSION=a; csrftoken=a",
            identity,
            "agent-a",
            { authorization: "Bearer a" },
        );
        const captured: IAuthSessionSnapshot = globalState.getAuthSession()!;

        await globalState.setSignedInSession(
            "LEETCODE_SESSION=b; csrftoken=b",
            { ...identity, username: "account-b" },
            "agent-b",
            { authorization: "Bearer b" },
        );

        assert.strictEqual(captured.identity && captured.identity.username, "account-a");
        assert.strictEqual(captured.browserRequestHeaders && captured.browserRequestHeaders.authorization, "Bearer a");
        assert.ok(!globalState.isAuthRevisionCurrent(captured.revision));
        const requestHeaders = createHeaders(captured.cookie!, "https://leetcode.com/problems/two-sum/", {
            browserUserAgent: captured.browserUserAgent,
            browserRequestHeaders: captured.browserRequestHeaders,
        });
        assert.strictEqual(requestHeaders.Cookie, "LEETCODE_SESSION=a; csrftoken=a");
        assert.strictEqual(requestHeaders.Authorization, "Bearer a");
        assert.strictEqual(requestHeaders["User-Agent"], "agent-a");
    });

    it("rehydrates and emits each remotely written snapshot once", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        await globalState.initialize(context(memento, secrets));
        const observed: IAuthSessionSnapshot[] = [];
        const subscription: vscode.Disposable = globalState.onDidChangeAuthSession((snapshot: IAuthSessionSnapshot) => observed.push(snapshot));
        const remote: IAuthSessionSnapshot = {
            version: 1,
            revision: Date.now() + 0.25,
            state: "signed-in",
            intentionalSignOut: false,
            cookie: "LEETCODE_SESSION=b; csrftoken=b",
            identity: { ...identity, username: "account-b" },
        };

        await secrets.store(authSessionKey, JSON.stringify(remote));
        await new Promise<void>((resolve: () => void) => setImmediate(resolve));
        await secrets.store(authSessionKey, JSON.stringify(remote));
        await new Promise<void>((resolve: () => void) => setImmediate(resolve));

        subscription.dispose();
        assert.strictEqual(observed.length, 1);
        assert.strictEqual(observed[0].identity && observed[0].identity!.username, "account-b");
        assert.strictEqual(globalState.getAuthSession()!.revision, remote.revision);
        assert.strictEqual(globalState.getAuthSession()!.cookie, remote.cookie);
    });

    it("keeps an intentional sign-out suspended across reinitialization", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        await globalState.initialize(context(memento, secrets));
        await globalState.setSignedOutSession(true);

        await globalState.initialize(context(memento, secrets));

        const snapshot: IAuthSessionSnapshot | undefined = globalState.getAuthSession();
        assert.strictEqual(snapshot && snapshot.state, "signed-out");
        assert.strictEqual(snapshot && snapshot.intentionalSignOut, true);
    });

    it("does not delete legacy fields when the atomic migration write fails", async () => {
        const memento: TestMemento = new TestMemento();
        const secrets: TestSecretStorage = new TestSecretStorage();
        memento.seed("leetcode-user-status", identity);
        secrets.values.set("leetcode-cookie", "LEETCODE_SESSION=a; csrftoken=a");
        secrets.failNextStore = true;

        await assert.rejects(globalState.initialize(context(memento, secrets)), /injected secret-store failure/);

        assert.strictEqual(secrets.values.get("leetcode-cookie"), "LEETCODE_SESSION=a; csrftoken=a");
        assert.deepStrictEqual(memento.get("leetcode-user-status"), identity);
        assert.ok(!secrets.values.has(authSessionKey));
    });
});
