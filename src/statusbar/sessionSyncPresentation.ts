// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IAuthSyncSummary } from "../auth/authSyncSummary";

// Pure view model for the session-sync status bar item and its quick pick.
// Kept free of `vscode` so every state can be unit-tested without a host; the
// status bar item and the command handler in extension.ts apply the result.
// Design record: docs/plans/status-bar-session-sync.md.

export const SESSION_SYNC_ERROR_BACKGROUND: string = "statusBarItem.errorBackground";
// Honored from VS Code 1.63; older hosts ignore it and the icon + text carry
// the state on their own.
export const SESSION_SYNC_WARNING_BACKGROUND: string = "statusBarItem.warningBackground";

export interface ISessionSyncItemView {
    visible: boolean;
    text: string;
    tooltip: string;
    backgroundThemeId: string | undefined;
    accessibilityLabel: string;
}

export type SessionSyncAction =
    | "details"
    | "restart"
    | "forceStart"
    | "showPortOwner"
    | "changePort"
    | "openProfile"
    | "signIn";

export interface ISessionSyncActionItem {
    label: string;
    description?: string;
    detail?: string;
    action: SessionSyncAction;
}

export interface ISessionSyncActions {
    placeholder: string;
    items: ISessionSyncActionItem[];
}

const HIDDEN_VIEW: ISessionSyncItemView = {
    visible: false,
    text: "",
    tooltip: "",
    backgroundThemeId: undefined,
    accessibilityLabel: "",
};

export function describeSessionSyncItem(
    summary: IAuthSyncSummary,
    options: { ready: boolean; justSynced: boolean },
): ISessionSyncItemView {
    if (!options.ready || summary.mode === "disabled") {
        return HIDDEN_VIEW;
    }

    const lastSync: string = `Last auth sync: ${formatAbsolute(summary.lastSyncedAt)}`;
    const portLabel: string = summary.port ? `Port ${summary.port}` : "The sync port";
    // The check only replaces a healthy icon: a sync can be observed while
    // vacant or blocked, and that must not hide the warning.
    const healthy: boolean = summary.mode === "local" || summary.mode === "observer";
    const justSynced: boolean = options.justSynced && healthy;

    let icon: string;
    let text: string = "";
    let hint: string;
    let backgroundThemeId: string | undefined;
    switch (summary.mode) {
        case "local":
            icon = "sync";
            hint = "Click for sync details and actions";
            break;
        case "observer":
            icon = "remote";
            hint = "Another VS Code window is syncing; this one gets its updates";
            break;
        case "vacant":
            icon = "warning";
            text = "Not syncing";
            hint = "This window will take over automatically within about a minute";
            backgroundThemeId = SESSION_SYNC_WARNING_BACKGROUND;
            break;
        case "stopped":
            icon = "debug-stop";
            text = "Sync stopped";
            hint = "Sync stopped after an error. Click to restart";
            backgroundThemeId = SESSION_SYNC_WARNING_BACKGROUND;
            break;
        case "conflict":
            icon = "error";
            text = "Sync blocked";
            hint = `${portLabel} is used by ${summary.conflictSummary || "another program"}`;
            backgroundThemeId = SESSION_SYNC_ERROR_BACKGROUND;
            break;
        default:
            icon = "sync";
            hint = "Click for sync details and actions";
            break;
    }

    return {
        visible: true,
        text: `$(${justSynced ? "check" : icon})${text ? ` ${text}` : ""}`,
        tooltip: [
            `${toneMarker(summary.tone)} ${summary.label}`,
            lastSync,
            justSynced ? "Received your LeetCode session just now" : hint,
        ].join("\n"),
        backgroundThemeId,
        accessibilityLabel: `LeetCode session sync: ${summary.label}`,
    };
}

export function buildSessionSyncActions(
    summary: IAuthSyncSummary,
    options: { signedIn: boolean; now: number },
): ISessionSyncActions {
    const port: string = summary.port ? String(summary.port) : "";
    const portSuffix: string = port ? ` ${port}` : "";
    const lastSync: string = formatRelative(summary.lastSyncedAt, options.now);
    const details: ISessionSyncActionItem = {
        label: "Show sync details",
        description: "port, owner window, secret, timing",
        action: "details",
    };
    const restart: ISessionSyncActionItem = {
        label: "Restart sync",
        description: port ? `port ${port}` : undefined,
        action: "restart",
    };

    let placeholder: string;
    let items: ISessionSyncActionItem[];
    switch (summary.mode) {
        case "local":
            placeholder = `Synced in this window · last sync ${lastSync}`;
            items = [details, restart];
            break;
        case "observer":
            placeholder = `Another window is syncing · last sync ${lastSync}`;
            items = [details, { label: "Sync in this window instead", description: "asks before moving", action: "forceStart" }];
            break;
        case "vacant":
            placeholder = `No window is syncing · this one takes over within a minute · last sync ${lastSync}`;
            items = [{ label: "Start syncing in this window", description: restart.description, action: "restart" }, details];
            break;
        case "stopped":
            placeholder = `Sync stopped after an error · last sync ${lastSync}`;
            items = [restart, details];
            break;
        case "conflict":
            placeholder = `Port${portSuffix} is used by ${summary.conflictSummary || "another program"}`;
            items = [
                { label: `Show what's using port${portSuffix}`, description: "copy an inspect or stop command", action: "showPortOwner" },
                { label: "Try again", description: "after the other program stops", action: "restart" },
                {
                    label: "Use a different port…",
                    description: "leetcode.authSync.port",
                    detail: "Set the same port in the browser extension options.",
                    action: "changePort",
                },
            ];
            break;
        default:
            placeholder = summary.label;
            items = [details];
            break;
    }

    items.push(options.signedIn
        ? { label: "Open profile", description: "solved counts and recent submissions", action: "openProfile" }
        : { label: "Sign in", description: "or sync from your browser", action: "signIn" });
    return { placeholder, items };
}

// The confirmation depends on the current mode: this command also runs from
// the command palette, where no other window may be syncing.
export function describeForceStartPrompt(mode: string): { message: string; confirm: string } | undefined {
    switch (mode) {
        case "disabled":
            return undefined;
        case "observer":
            return { message: "Move LeetCode session sync to this window? The other window will stop syncing.", confirm: "Move Here" };
        case "local":
            return { message: "Restart LeetCode session sync in this window?", confirm: "Restart" };
        default:
            return { message: "Start LeetCode session sync in this window?", confirm: "Start" };
    }
}

export function formatAbsolute(timestamp: number | undefined): string {
    return typeof timestamp === "number" && timestamp > 0
        ? new Date(timestamp).toLocaleString()
        : "never";
}

export function formatRelative(timestamp: number | undefined, now: number): string {
    if (typeof timestamp !== "number" || timestamp <= 0) {
        return "never";
    }
    const seconds: number = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 45) {
        return "just now";
    }
    const minutes: number = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours: number = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return formatAbsolute(timestamp);
}

function toneMarker(tone: IAuthSyncSummary["tone"]): string {
    switch (tone) {
        case "ok":
            return "✓";
        case "warn":
            return "⚠";
        case "bad":
            return "✕";
        default:
            return "•";
    }
}
