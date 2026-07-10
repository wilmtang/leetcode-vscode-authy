// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { globalState } from "../globalState";
import { authSyncServer, IAuthSyncStatusSnapshot } from "./authSyncServer";

export type AuthSyncTone = "ok" | "warn" | "bad" | "neutral";

// A formatted, view-agnostic snapshot of the cookie/auth-sync state. Both the
// profile panel's "Session Sync" card and the status-bar tooltip render from
// this, so the wording ("Syncing your LeetCode session here", etc.) is defined
// once here and stays identical across both surfaces. Timestamps are Unix ms.
export interface IAuthSyncSummary {
    mode: string;
    // Human-readable status line that says *what* is syncing and *where*.
    label: string;
    tone: AuthSyncTone;
    lastSyncedAt: number | undefined;
    port: number | undefined;
    ownedByThisWindow: boolean;
    ownerWindowLabel: string | undefined;
    ownerHeartbeatAt: number | undefined;
    currentWindowLabel: string;
    hasConflict: boolean;
    conflictSummary: string | undefined;
}

// One-line explanation of what the card/tooltip is about. Kept short so it can
// sit under the status line without crowding the layout. The sync carries the
// full request identity (login cookie, request headers, and user agent), not
// just the cookie — see authSyncServer's cookie/headers/userAgent capture.
export const AUTH_SYNC_CAPTION: string = "Your LeetCode auth — login cookie, request headers, and user agent — synced from the companion browser extension.";

export function getAuthSyncSummary(): IAuthSyncSummary {
    const snapshot: IAuthSyncStatusSnapshot = authSyncServer.getStatusSnapshot();
    const view: { label: string; tone: AuthSyncTone } = describeMode(snapshot.mode);
    return {
        mode: snapshot.mode,
        label: view.label,
        tone: view.tone,
        lastSyncedAt: globalState.getAuthSyncLastSyncedAt(),
        port: snapshot.port,
        ownedByThisWindow: snapshot.mode === "local",
        ownerWindowLabel: snapshot.owner && snapshot.owner.windowLabel,
        ownerHeartbeatAt: snapshot.owner && snapshot.owner.heartbeatAt,
        currentWindowLabel: snapshot.currentWindow.windowLabel,
        hasConflict: snapshot.mode === "conflict" || !!snapshot.conflict,
        conflictSummary: snapshot.conflict && snapshot.conflict.summary,
    };
}

function describeMode(mode: string): { label: string; tone: AuthSyncTone } {
    switch (mode) {
        case "local":
            return { label: "Syncing your LeetCode session here", tone: "ok" };
        case "observer":
            return { label: "LeetCode session synced by another window", tone: "ok" };
        case "vacant":
            return { label: "No window is syncing your LeetCode session", tone: "warn" };
        case "stopped":
            return { label: "LeetCode session sync paused", tone: "warn" };
        case "conflict":
            return { label: "LeetCode session sync port conflict", tone: "bad" };
        case "disabled":
            return { label: "Automatic session sync is off", tone: "neutral" };
        default:
            return { label: mode || "Unknown", tone: "neutral" };
    }
}
