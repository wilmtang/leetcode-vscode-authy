// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { AuthSyncTone, getAuthSyncSummary, IAuthSyncSummary } from "../auth/authSyncSummary";
import { UserStatus } from "../shared";

export class LeetCodeStatusBarItem implements vscode.Disposable {
    private readonly statusBarItem: vscode.StatusBarItem;

    constructor() {
        // The status bar item used to open session management (now retired). When
        // signed in, route the click to the user-profile panel (solved counts,
        // ranking, recent AC submissions, session-sync status). When signed out,
        // route to the existing sign-in prompt so the click is never a dead-end.
        this.statusBarItem = vscode.window.createStatusBarItem();
        this.statusBarItem.command = "leetcode.signin";
        this.statusBarItem.tooltip = "Sign in to LeetCode";
    }

    public updateStatusBar(status: UserStatus, user?: string): void {
        switch (status) {
            case UserStatus.SignedIn:
                this.statusBarItem.text = `LeetCode: ${user}`;
                this.statusBarItem.command = "leetcode.showUserProfile";
                this.statusBarItem.tooltip = buildSignedInTooltip(user || "");
                break;
            case UserStatus.SignedOut:
            default:
                this.statusBarItem.text = "";
                this.statusBarItem.command = "leetcode.signin";
                this.statusBarItem.tooltip = "Sign in to LeetCode";
                break;
        }
    }

    public show(): void {
        this.statusBarItem.show();
    }

    public hide(): void {
        this.statusBarItem.hide();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}

// Hover tooltip: what the click does, plus a concise snapshot of the session
// sync state. The last-sync time is absolute (not "x ago") because a status-bar
// tooltip is computed once and would otherwise read stale on a later hover; the
// profile panel shows the live, ticking relative time. (StatusBarItem.tooltip is
// a plain string on this engine, so the tone is shown with a unicode marker.)
function buildSignedInTooltip(user: string): string {
    const sync: IAuthSyncSummary = getAuthSyncSummary();
    const lastSync: string = typeof sync.lastSyncedAt === "number" && sync.lastSyncedAt > 0
        ? new Date(sync.lastSyncedAt).toLocaleString()
        : "never";
    return [
        `LeetCode: ${user || "signed in"}`,
        `${toneMarker(sync.tone)} ${sync.label}`,
        `Last auth sync: ${lastSync}`,
        `Click to open your profile & session sync`,
    ].join("\n");
}

function toneMarker(tone: AuthSyncTone): string {
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
