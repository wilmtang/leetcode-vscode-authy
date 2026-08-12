// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";

interface ICatalogCache {
    invalidate(): void;
}

interface ITreeRefresher {
    refresh(force?: boolean): Promise<void>;
}

// Delete the process-local catalog and visibly repopulate the explorer. The
// optional arguments keep the public command deterministic in offline tests.
export async function deleteCache(
    cache: ICatalogCache = explorerNodeManager,
    tree: ITreeRefresher = leetCodeTreeDataProvider,
): Promise<void> {
    cache.invalidate();
    await tree.refresh(true);
}
