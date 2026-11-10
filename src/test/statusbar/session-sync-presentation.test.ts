import * as assert from "assert";
import { IAuthSyncSummary } from "../../auth/authSyncSummary";
import {
    buildSessionSyncActions,
    describeForceStartPrompt,
    describeSessionSyncItem,
    formatRelative,
    ISessionSyncItemView,
    SESSION_SYNC_ERROR_BACKGROUND,
    SESSION_SYNC_WARNING_BACKGROUND,
} from "../../statusbar/sessionSyncPresentation";

const LABELS: { [mode: string]: { label: string; tone: IAuthSyncSummary["tone"] } } = {
    local: { label: "Syncing your LeetCode session here", tone: "ok" },
    observer: { label: "LeetCode session synced by another window", tone: "ok" },
    vacant: { label: "No window is syncing your LeetCode session", tone: "warn" },
    stopped: { label: "LeetCode session sync stopped", tone: "warn" },
    conflict: { label: "LeetCode session sync port conflict", tone: "bad" },
    disabled: { label: "Automatic session sync is off", tone: "neutral" },
};

function summary(mode: string, extra: Partial<IAuthSyncSummary> = {}): IAuthSyncSummary {
    return {
        mode,
        label: LABELS[mode].label,
        tone: LABELS[mode].tone,
        lastSyncedAt: Date.UTC(2026, 10, 10, 10, 6, 6),
        port: 17899,
        ownedByThisWindow: mode === "local",
        ownerWindowLabel: undefined,
        ownerHeartbeatAt: undefined,
        currentWindowLabel: "leetcode",
        hasConflict: mode === "conflict",
        conflictSummary: mode === "conflict" ? "node (pid 4182)" : undefined,
        ...extra,
    };
}

function view(mode: string, justSynced: boolean = false, extra: Partial<IAuthSyncSummary> = {}): ISessionSyncItemView {
    return describeSessionSyncItem(summary(mode, extra), { ready: true, justSynced });
}

describe("session sync status bar presentation", () => {
    it("renders each mode with a distinct icon, words only when action is needed, and a tone background", () => {
        const expected: Array<[string, string, string | undefined]> = [
            ["local", "$(sync)", undefined],
            ["observer", "$(remote)", undefined],
            ["vacant", "$(warning) Not syncing", SESSION_SYNC_WARNING_BACKGROUND],
            ["stopped", "$(debug-stop) Sync stopped", SESSION_SYNC_WARNING_BACKGROUND],
            ["conflict", "$(error) Sync blocked", SESSION_SYNC_ERROR_BACKGROUND],
        ];
        for (const [mode, text, background] of expected) {
            const rendered: ISessionSyncItemView = view(mode);
            assert.strictEqual(rendered.visible, true, mode);
            assert.strictEqual(rendered.text, text, mode);
            assert.strictEqual(rendered.backgroundThemeId, background, mode);
            assert.ok(rendered.tooltip.includes(LABELS[mode].label), mode);
            assert.ok(rendered.tooltip.includes("Last auth sync: "), mode);
            assert.strictEqual(rendered.accessibilityLabel, `LeetCode session sync: ${LABELS[mode].label}`, mode);
        }
    });

    it("names the conflicting program, or falls back when none was recorded", () => {
        assert.ok(view("conflict").tooltip.includes("Port 17899 is used by node (pid 4182)"));
        assert.ok(view("conflict", false, { conflictSummary: undefined }).tooltip.includes("Port 17899 is used by another program"));
    });

    it("hides the item while sync is turned off and before the first start settles", () => {
        assert.strictEqual(view("disabled").visible, false);
        assert.strictEqual(describeSessionSyncItem(summary("local"), { ready: false, justSynced: false }).visible, false);
        assert.strictEqual(describeSessionSyncItem(summary("stopped"), { ready: false, justSynced: false }).visible, false);
    });

    it("shows the just-synced check only over a healthy state, never over a warning or error", () => {
        for (const mode of ["local", "observer"]) {
            const rendered: ISessionSyncItemView = view(mode, true);
            assert.strictEqual(rendered.text, "$(check)", mode);
            assert.ok(rendered.tooltip.includes("Received your LeetCode session just now"), mode);
        }
        for (const mode of ["vacant", "stopped", "conflict"]) {
            assert.deepStrictEqual(view(mode, true), view(mode, false), mode);
        }
    });

    it("keeps the tooltip's last sync time absolute and says never when nothing has synced", () => {
        assert.ok(view("local", false, { lastSyncedAt: undefined }).tooltip.includes("Last auth sync: never"));
        assert.ok(!/ago/.test(view("local").tooltip));
    });

    it("opens healthy states on details and problem states on their fix", () => {
        const first = (mode: string): string => buildSessionSyncActions(summary(mode), { signedIn: true, now: Date.now() }).items[0].action;
        assert.strictEqual(first("local"), "details");
        assert.strictEqual(first("observer"), "details");
        assert.strictEqual(first("vacant"), "restart");
        assert.strictEqual(first("stopped"), "restart");
        assert.strictEqual(first("conflict"), "showPortOwner");
    });

    it("lists every action per mode in order and ends with profile or sign in", () => {
        const actions = (mode: string, signedIn: boolean): string[] =>
            buildSessionSyncActions(summary(mode), { signedIn, now: Date.now() }).items.map((item) => item.action);
        assert.deepStrictEqual(actions("local", true), ["details", "restart", "openProfile"]);
        assert.deepStrictEqual(actions("observer", true), ["details", "forceStart", "openProfile"]);
        assert.deepStrictEqual(actions("vacant", false), ["restart", "details", "signIn"]);
        assert.deepStrictEqual(actions("stopped", false), ["restart", "details", "signIn"]);
        assert.deepStrictEqual(actions("conflict", true), ["showPortOwner", "restart", "changePort", "openProfile"]);
    });

    it("puts the current state in the quick pick placeholder", () => {
        const now: number = Date.UTC(2026, 10, 10, 10, 10, 6);
        assert.strictEqual(buildSessionSyncActions(summary("local"), { signedIn: true, now }).placeholder, "Synced in this window · last sync 4 min ago");
        assert.strictEqual(buildSessionSyncActions(summary("conflict"), { signedIn: true, now }).placeholder, "Port 17899 is used by node (pid 4182)");
        const conflict = buildSessionSyncActions(summary("conflict"), { signedIn: true, now });
        assert.strictEqual(conflict.items[0].label, "Show what's using port 17899");
        assert.strictEqual(conflict.items[2].detail, "Set the same port in the browser extension options.");
    });

    it("words the force-start confirmation for the current mode", () => {
        assert.strictEqual(describeForceStartPrompt("disabled"), undefined);
        assert.deepStrictEqual(describeForceStartPrompt("observer"), {
            message: "Move LeetCode session sync to this window? The other window will stop syncing.",
            confirm: "Move Here",
        });
        assert.strictEqual(describeForceStartPrompt("local")!.confirm, "Restart");
        for (const mode of ["vacant", "stopped", "conflict"]) {
            assert.deepStrictEqual(describeForceStartPrompt(mode), { message: "Start LeetCode session sync in this window?", confirm: "Start" }, mode);
        }
    });

    it("formats relative last-sync times", () => {
        const now: number = Date.UTC(2026, 10, 10);
        assert.strictEqual(formatRelative(undefined, now), "never");
        assert.strictEqual(formatRelative(now - 10_000, now), "just now");
        assert.strictEqual(formatRelative(now - 4 * 60_000, now), "4 min ago");
        assert.strictEqual(formatRelative(now - 3 * 3_600_000, now), "3 h ago");
    });
});
