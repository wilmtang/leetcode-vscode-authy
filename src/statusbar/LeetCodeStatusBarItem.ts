// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import { getAuthSyncSummary } from "../auth/authSyncSummary";
import { UserStatus } from "../shared";
import { describeSessionSyncItem, ISessionSyncItemView } from "./sessionSyncPresentation";

// Left-aligned with adjacent priorities just below 0, so items that set no
// priority (0) stay to the left and only an item with a priority between these
// two could land between them. Separate ids let VS Code's status bar context
// menu hide either one on its own.
export const ACCOUNT_STATUS_BAR_ID: string = "leetcode.status.account";
export const SESSION_SYNC_STATUS_BAR_ID: string = "leetcode.status.sessionSync";
const ACCOUNT_PRIORITY: number = -0.0001;
const SESSION_SYNC_PRIORITY: number = -0.0002;
export const JUST_SYNCED_MS: number = 2000;

export class LeetCodeStatusBarItem implements vscode.Disposable {
    private readonly accountItem: vscode.StatusBarItem;
    private readonly syncItem: vscode.StatusBarItem;
    private enabled: boolean = false;
    private syncReady: boolean = false;
    private justSyncedTimer: NodeJS.Timer | undefined;

    constructor() {
        // Signed in, the account item opens the profile panel (solved counts,
        // ranking, recent AC submissions). Signed out, it opens the sign-in
        // prompt so the click is never a dead end.
        this.accountItem = vscode.window.createStatusBarItem(ACCOUNT_STATUS_BAR_ID, vscode.StatusBarAlignment.Left, ACCOUNT_PRIORITY);
        this.accountItem.name = "LeetCode Account";
        // Signed-out startup never emits a status change, so set the
        // signed-out text up front instead of showing an empty item.
        this.accountItem.text = "LeetCode: Sign In";
        this.accountItem.command = "leetcode.signin";
        this.accountItem.tooltip = "Sign in to LeetCode";

        this.syncItem = vscode.window.createStatusBarItem(SESSION_SYNC_STATUS_BAR_ID, vscode.StatusBarAlignment.Left, SESSION_SYNC_PRIORITY);
        this.syncItem.name = "LeetCode Session Sync";
        this.syncItem.command = "leetcode.authSync.showActions";
    }

    public updateStatusBar(status: UserStatus, user?: string): void {
        switch (status) {
            case UserStatus.SignedIn:
                this.accountItem.text = `LeetCode: ${user}`;
                this.accountItem.command = "leetcode.showUserProfile";
                this.accountItem.tooltip = `LeetCode: ${user || "signed in"}\nClick to open your profile`;
                break;
            case UserStatus.SignedOut:
            default:
                this.accountItem.text = "LeetCode: Sign In";
                this.accountItem.command = "leetcode.signin";
                this.accountItem.tooltip = "Sign in to LeetCode";
                break;
        }
    }

    // Shown only once the first auth-sync start has settled, so activation
    // never flashes the initial "stopped" state.
    public setSyncReady(): void {
        this.syncReady = true;
        this.updateSync();
    }

    // A session just arrived: show the check for JUST_SYNCED_MS. A new sync
    // restarts the timer rather than stacking another one.
    public markSynced(): void {
        this.clearJustSyncedTimer();
        this.justSyncedTimer = setTimeout(() => {
            this.justSyncedTimer = undefined;
            this.updateSync();
        }, JUST_SYNCED_MS);
        this.updateSync();
    }

    public updateSync(): void {
        if (!this.syncReady) {
            // Also avoids reading auth state before globalState is initialized.
            this.syncItem.hide();
            return;
        }
        const view: ISessionSyncItemView = describeSessionSyncItem(getAuthSyncSummary(), {
            ready: this.syncReady,
            justSynced: this.justSyncedTimer !== undefined,
        });
        this.syncItem.text = view.text;
        this.syncItem.tooltip = view.tooltip;
        this.syncItem.backgroundColor = view.backgroundThemeId ? new vscode.ThemeColor(view.backgroundThemeId) : undefined;
        this.syncItem.accessibilityInformation = { label: view.accessibilityLabel };
        if (this.enabled && view.visible) {
            this.syncItem.show();
        } else {
            this.syncItem.hide();
        }
    }

    public show(): void {
        this.enabled = true;
        this.accountItem.show();
        this.updateSync();
    }

    public hide(): void {
        this.enabled = false;
        this.accountItem.hide();
        this.syncItem.hide();
    }

    public dispose(): void {
        this.clearJustSyncedTimer();
        this.accountItem.dispose();
        this.syncItem.dispose();
    }

    private clearJustSyncedTimer(): void {
        if (this.justSyncedTimer) {
            clearTimeout(this.justSyncedTimer);
            this.justSyncedTimer = undefined;
        }
    }
}
