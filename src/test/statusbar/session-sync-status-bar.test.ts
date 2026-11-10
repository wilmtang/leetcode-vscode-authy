import * as assert from "assert";
import * as net from "net";
import * as vscode from "vscode";
import { parseLsofOutput } from "../../auth/authSyncPortInspector";
import { authSyncServer } from "../../auth/authSyncServer";
import { globalState } from "../../globalState";
import {
    ACCOUNT_STATUS_BAR_ID,
    JUST_SYNCED_MS,
    LeetCodeStatusBarItem,
    SESSION_SYNC_STATUS_BAR_ID,
} from "../../statusbar/LeetCodeStatusBarItem";
import { UserStatus } from "../../shared";

interface IRecordedItem {
    id: string | undefined;
    alignment: number;
    priority: number;
    name: string | undefined;
    text: string;
    tooltip: string;
    command: string | undefined;
    backgroundColor: { id: string } | undefined;
    accessibilityInformation: { label: string } | undefined;
    visible: boolean;
    disposed: boolean;
}

class MemoryMemento {
    private readonly values: Map<string, unknown> = new Map<string, unknown>();
    public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
    public update(key: string, value: unknown): Promise<void> {
        if (value === undefined) { this.values.delete(key); } else { this.values.set(key, value); }
        return Promise.resolve();
    }
}

class MemorySecrets {
    private readonly values: Map<string, string> = new Map<string, string>();
    public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
    public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
    public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
    public onDidChange(): vscode.Event<void> { return (() => new vscode.Disposable(() => undefined)) as vscode.Event<void>; }
}

function recordedItems(): IRecordedItem[] {
    return (vscode.window as unknown as { __createdStatusBarItems: IRecordedItem[] }).__createdStatusBarItems;
}

function itemsOf(): { account: IRecordedItem; sync: IRecordedItem } {
    const items: IRecordedItem[] = recordedItems();
    const account: IRecordedItem | undefined = [...items].reverse().find((item: IRecordedItem) => item.id === ACCOUNT_STATUS_BAR_ID);
    const sync: IRecordedItem | undefined = [...items].reverse().find((item: IRecordedItem) => item.id === SESSION_SYNC_STATUS_BAR_ID);
    assert.ok(account && sync, "both status bar items should be created with their ids");
    return { account: account!, sync: sync! };
}

async function waitFor(condition: () => boolean, describe: () => string, timeoutMs: number): Promise<void> {
    const deadline: number = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            assert.fail(`timed out; last value: ${describe()}`);
        }
        await new Promise<void>((resolve: () => void) => setTimeout(resolve, 25));
    }
}

function clearConfig(): void {
    delete (global as unknown as { __LC_TEST_CONFIG__?: unknown }).__LC_TEST_CONFIG__;
}

async function withBlocker(port: number, run: () => Promise<void>): Promise<void> {
    const blocker: net.Server = net.createServer((socket: net.Socket) => socket.destroy());
    await new Promise<void>((resolve: () => void) => blocker.listen(port, "127.0.0.1", resolve));
    try {
        await run();
    } finally {
        await new Promise<void>((resolve: () => void) => blocker.close(() => resolve()));
    }
}

function setConfig(port: number, enabled: boolean = true): void {
    (global as unknown as { __LC_TEST_CONFIG__: { [key: string]: unknown } }).__LC_TEST_CONFIG__ = {
        "authSync.enabled": enabled,
        "authSync.port": port,
    };
}

describe("session sync status bar", () => {
    before(async () => {
        await globalState.initialize({
            globalState: new MemoryMemento(),
            secrets: new MemorySecrets(),
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);
    });

    afterEach(async () => {
        await authSyncServer.stop();
    });

    after(clearConfig);

    it("creates two adjacent, separately hideable left items", () => {
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { account, sync } = itemsOf();
        assert.strictEqual(account.alignment, vscode.StatusBarAlignment.Left);
        assert.strictEqual(sync.alignment, vscode.StatusBarAlignment.Left);
        assert.ok(account.priority > sync.priority, "the sync item sits right of the account item");
        assert.strictEqual(account.name, "LeetCode Account");
        assert.strictEqual(sync.name, "LeetCode Session Sync");
        assert.strictEqual(sync.command, "leetcode.authSync.showActions");
        bar.dispose();
    });

    it("labels the account item before any sign-in status arrives", () => {
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { account } = itemsOf();
        assert.strictEqual(account.text, "LeetCode: Sign In");
        assert.strictEqual(account.command, "leetcode.signin");
        bar.dispose();
    });

    it("keeps the account item's click and drops sync lines from its tooltip", () => {
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { account } = itemsOf();
        bar.updateStatusBar(UserStatus.SignedIn, "SleezyBunny");
        assert.strictEqual(account.text, "LeetCode: SleezyBunny");
        assert.strictEqual(account.command, "leetcode.showUserProfile");
        assert.strictEqual(account.tooltip, "LeetCode: SleezyBunny\nClick to open your profile");
        bar.updateStatusBar(UserStatus.SignedOut);
        assert.strictEqual(account.command, "leetcode.signin");
        bar.dispose();
    });

    it("hides the sync item until the first start settles, then follows the server mode", async () => {
        setConfig(18991);
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { account, sync } = itemsOf();
        bar.show();
        assert.strictEqual(account.visible, true);
        assert.strictEqual(sync.visible, false, "the initial stopped mode must not flash");

        await authSyncServer.start();
        bar.setSyncReady();
        assert.strictEqual(sync.visible, true);
        assert.strictEqual(sync.text, "$(sync)");
        assert.strictEqual(sync.accessibilityInformation!.label, "LeetCode session sync: Syncing your LeetCode session here");

        await authSyncServer.stop();
        bar.updateSync();
        assert.strictEqual(sync.text, "$(debug-stop) Sync stopped");
        assert.strictEqual(sync.backgroundColor!.id, "statusBarItem.warningBackground");

        bar.hide();
        assert.strictEqual(sync.visible, false, "leetcode.enableStatusBar hides both items");
        bar.dispose();
        assert.strictEqual(sync.disposed, true);
    });

    it("hides the sync item while sync is turned off", async () => {
        setConfig(18992, false);
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { sync } = itemsOf();
        bar.show();
        await authSyncServer.start();
        bar.setSyncReady();
        assert.strictEqual(sync.visible, false);
        bar.dispose();
    });

    it("shows the just-synced check, restarts it on a repeat sync, then reverts", async function () {
        this.timeout(JUST_SYNCED_MS * 3);
        setConfig(18993);
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        const { sync } = itemsOf();
        bar.show();
        await authSyncServer.start();
        bar.setSyncReady();

        bar.markSynced();
        assert.strictEqual(sync.text, "$(check)");
        const firstAt: number = Date.now();
        await new Promise<void>((resolve: () => void) => setTimeout(resolve, JUST_SYNCED_MS / 2));
        bar.markSynced();
        const secondAt: number = Date.now();
        await waitFor(() => sync.text === "$(sync)", () => sync.text, JUST_SYNCED_MS * 2);
        assert.ok(Date.now() - secondAt >= JUST_SYNCED_MS - 50, `the repeat sync restarts the timer (reverted ${Date.now() - firstAt} ms after the first sync)`);
        bar.dispose();
    });

    it("clears a pending just-synced timer on dispose", async () => {
        setConfig(18994);
        const bar: LeetCodeStatusBarItem = new LeetCodeStatusBarItem();
        await authSyncServer.start();
        bar.setSyncReady();
        bar.markSynced();
        bar.dispose();
        assert.strictEqual((bar as unknown as { justSyncedTimer: unknown }).justSyncedTimer, undefined);
    });
});

describe("auth sync status changes", () => {
    let events: number = 0;
    let modesSeen: string[] = [];
    let subscription: vscode.Disposable;

    before(async () => {
        await globalState.initialize({
            globalState: new MemoryMemento(),
            secrets: new MemorySecrets(),
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);
        subscription = authSyncServer.onDidChangeStatus(() => {
            events++;
            modesSeen.push(authSyncServer.getStatusSnapshot().mode);
        });
    });

    beforeEach(() => {
        events = 0;
        modesSeen = [];
    });

    after(async () => {
        subscription.dispose();
        await authSyncServer.stop();
        clearConfig();
    });

    it("fires once per real transition and not on a no-op refresh", async () => {
        setConfig(18995);
        await authSyncServer.stop();
        events = 0;
        await authSyncServer.start();
        assert.strictEqual(events, 1, "stopped -> local");
        await authSyncServer.refreshStatus();
        assert.strictEqual(events, 1, "refresh with nothing changed must not fire");
        await authSyncServer.stop();
        assert.strictEqual(events, 2, "local -> stopped");
    });

    it("fires nothing for a restart that ends where it began, so no stopped flash", async () => {
        setConfig(18996);
        await authSyncServer.start();
        events = 0;
        await authSyncServer.restart();
        assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "local");
        assert.strictEqual(events, 0, "the transient stopped state inside restart must not be emitted");
    });

    it("fires exactly once for a restart that changes state, never showing stopped", async function () {
        this.timeout(8000);
        setConfig(18999);
        await authSyncServer.start();
        assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "local");
        await withBlocker(19000, async () => {
            setConfig(19000);
            events = 0;
            modesSeen = [];
            await authSyncServer.restart();
            assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "conflict");
            assert.strictEqual(events, 1);
            assert.deepStrictEqual(modesSeen, ["conflict"]);
        });
    });

    it("still settles and emits when a queued start rejects", async () => {
        setConfig(19001);
        await authSyncServer.stop();
        events = 0;
        const server = authSyncServer as unknown as { listenLocal(port: number): Promise<void> };
        const original: (port: number) => Promise<void> = server.listenLocal;
        server.listenLocal = () => Promise.reject(new Error("EACCES: permission denied"));
        try {
            await assert.rejects(authSyncServer.start(), /EACCES/);
        } finally {
            server.listenLocal = original;
        }
        assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "stopped");
        await authSyncServer.start();
        assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "local");
        assert.strictEqual(events, 1, "the counter recovered, so the later start emitted");
    });

    it("drops an observer-check result when sync is turned off while it runs", async function () {
        this.timeout(8000);
        const port: number = 19002;
        setConfig(port);
        await authSyncServer.stop();
        await withBlocker(port, async () => {
            const check: Promise<void> = (authSyncServer as unknown as { runObserverCheck(): Promise<void> }).runObserverCheck();
            setConfig(port, false);
            await authSyncServer.restart();
            await check;
            assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "disabled");
        });
    });

    it("emits once after back-to-back queued operations drain", async () => {
        setConfig(18997);
        await authSyncServer.stop();
        events = 0;
        await Promise.all([authSyncServer.start(), authSyncServer.stop(), authSyncServer.start()]);
        assert.strictEqual(events, 1);
        assert.strictEqual(authSyncServer.getStatusSnapshot().mode, "local");
    });

    it("records the port owner when the observer check finds a foreign program", async function () {
        this.timeout(8000);
        const port: number = 18998;
        setConfig(port);
        await authSyncServer.stop();
        await withBlocker(port, async () => {
            events = 0;
            const server = authSyncServer as unknown as { runObserverCheck(): Promise<void> };
            await server.runObserverCheck();
            const snapshot = authSyncServer.getStatusSnapshot();
            assert.strictEqual(snapshot.mode, "conflict");
            assert.ok(snapshot.conflict, "a timer-detected conflict must describe the port owner");
            assert.strictEqual(snapshot.conflict!.port, port);
            assert.strictEqual(events, 1);
            // A later tick reuses the recorded owner instead of re-inspecting.
            await server.runObserverCheck();
            assert.strictEqual(authSyncServer.getStatusSnapshot().conflict, snapshot.conflict);
            assert.strictEqual(events, 1);
        });
    });
});

describe("port owner lookup", () => {
    it("decodes lsof's escaped command names", () => {
        const output: string = [
            "COMMAND                  PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
            "Code\\x20Helper\\x20(Plugin) 23662 user 31u  IPv4 0x1      0t0  TCP 127.0.0.1:64438 (LISTEN)",
        ].join("\n");
        assert.deepStrictEqual(parseLsofOutput(output), { command: "Code Helper (Plugin)", pid: "23662" });
    });

    it("keeps control bytes escaped in decoded names", () => {
        const output: string = [
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
            "evil\\x0a\\x1b[2Jname 4242 user 3u IPv4 0x1 0t0 TCP 127.0.0.1:1 (LISTEN)",
        ].join("\n");
        assert.deepStrictEqual(parseLsofOutput(output), { command: "evil\\x0a\\x1b[2Jname", pid: "4242" });
    });
});
