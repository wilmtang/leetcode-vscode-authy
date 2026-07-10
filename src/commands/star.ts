
// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { customCodeLensProvider } from "../codelens/CustomCodeLensProvider";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { addFavoriteQuestion, removeFavoriteQuestion } from "../request/leetcode-api";
import { hasStarShortcut } from "../utils/settingUtils";
import { DialogType, promptForOpenOutputChannel } from "../utils/uiUtils";

export async function addFavorite(node: LeetCodeNode): Promise<void> {
    try {
        await toggleFavorite(node, true);
    } catch (error) {
        await promptForOpenOutputChannel("Failed to add the problem to favorite. Please open the output channel for details.", DialogType.error);
    }
}

export async function removeFavorite(node: LeetCodeNode): Promise<void> {
    try {
        await toggleFavorite(node, false);
    } catch (error) {
        await promptForOpenOutputChannel("Failed to remove the problem from favorite. Please open the output channel for details.", DialogType.error);
    }
}

async function toggleFavorite(node: LeetCodeNode, addToFavorite: boolean): Promise<void> {
    const titleSlug: string | undefined = node.titleSlug;
    if (!titleSlug) {
        throw new Error(`Cannot resolve the problem slug for "${node.name}".`);
    }

    if (addToFavorite) {
        await addFavoriteQuestion(titleSlug);
    } else {
        await removeFavoriteQuestion(titleSlug);
    }

    // Reflect the change in the cached catalog and soft-refresh, instead of
    // re-fetching the whole catalog just to move one node in/out of Favorites.
    explorerNodeManager.setProblemFavorite(node.id, addToFavorite);
    await leetCodeTreeDataProvider.refresh(false /* soft */);
    if (hasStarShortcut()) {
        customCodeLensProvider.refresh();
    }
}
