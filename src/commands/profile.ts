// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getAuthSyncSummary } from "../auth/authSyncSummary";
import { globalState, UserDataType } from "../globalState";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import {
    fetchProfileIdentity,
    fetchProfileLanguages,
    fetchProfileRecent,
    fetchProfileStats,
} from "../request/leetcode-api";
import { UserStatus } from "../shared";
import { promptForSignIn } from "../utils/uiUtils";
import { IProfileSyncStatus, leetCodeProfileProvider, ProfileSectionId } from "../webview/leetCodeProfileProvider";
import { ProfileRequestCoordinator } from "../webview/profileRequestCoordinator";

const profileRequests: ProfileRequestCoordinator = new ProfileRequestCoordinator();

// Status bar action: render the signed-in user's public profile (solved counts
// by difficulty, ranking, recent AC, language stats) plus the local cookie-sync
// status. The panel opens immediately with a shell; the four profile queries are
// fired independently and each section fills the moment its query lands, so a
// slow or failed query never holds up the rest. When signed out, route to the
// sign-in prompt so the click is never a dead-end.
export async function showUserProfile(): Promise<void> {
    if (leetCodeManager.getStatus() !== UserStatus.SignedIn) {
        promptForSignIn();
        return;
    }

    const username: string | undefined = leetCodeManager.getUser();
    if (!username) {
        promptForSignIn();
        return;
    }

    const cached: UserDataType | undefined = globalState.getUserStatus();
    const authRevision: number | undefined = globalState.getAuthSession() && globalState.getAuthSession()!.revision;
    if (authRevision === undefined) {
        return;
    }
    const owner = profileRequests.begin(authRevision);
    leetCodeProfileProvider.open({
        username,
        avatar: (cached && cached.avatar) || "",
        syncStatus: gatherSyncStatus(username, cached),
    });

    // No Promise.all: each query renders its section independently as it lands.
    void fetchSection(owner, "header", () => fetchProfileIdentity(username), (data) => leetCodeProfileProvider.updateIdentity(data));
    void fetchSection(owner, "totals", () => fetchProfileStats(username), (data) => leetCodeProfileProvider.updateStats(data));
    void fetchSection(owner, "recent", () => fetchProfileRecent(username), (data) => leetCodeProfileProvider.updateRecent(data));
    void fetchSection(owner, "languages", () => fetchProfileLanguages(username), (data) => leetCodeProfileProvider.updateLanguages(data));
}

async function fetchSection<T>(owner: { authRevision: number; generation: number }, id: ProfileSectionId, fetch: () => Promise<T>, apply: (data: T) => void): Promise<void> {
    try {
        const data: T = await fetch();
        if (profileRequests.isCurrent(owner, globalState.getAuthSession() && globalState.getAuthSession()!.revision)) {
            apply(data);
        }
    } catch (error) {
        if (!profileRequests.isCurrent(owner, globalState.getAuthSession() && globalState.getAuthSession()!.revision)) {
            return;
        }
        leetCodeChannel.appendLine(`[profile] section "${id}" failed: ${String(error)}`);
        leetCodeProfileProvider.failSection(id, "Couldn't load this section — see the LeetCode output channel.");
    }
}

export function invalidateProfileRequests(): void {
    profileRequests.invalidate();
}

// Current sync status for the signed-in user, shaped for the panel. Exported so
// the auth-sync event handler can push a fresh card into an already-open panel.
export function currentProfileSyncStatus(): IProfileSyncStatus {
    const cached: UserDataType | undefined = globalState.getUserStatus();
    const username: string = leetCodeManager.getUser() || (cached && cached.username) || "";
    return gatherSyncStatus(username, cached);
}

// Snapshots the local cookie/auth-sync state for the panel's "Session Sync"
// card. All of this is synchronous local state (no network), so the card paints
// immediately. The label/tone/timestamps come from the shared summary that also
// backs the session-sync status bar item; only the account fields are added here.
function gatherSyncStatus(username: string, cached: UserDataType | undefined): IProfileSyncStatus {
    return {
        ...getAuthSyncSummary(),
        username: (cached && cached.username) || username,
        isPremium: !!(cached && cached.isPremium),
        isVerified: !!(cached && cached.isVerified),
    };
}
