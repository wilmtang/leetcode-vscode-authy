// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

// Deprecated no-op. The extension no longer maintains a bundled-CLI cache; the
// problem list and details are fetched directly each time. Kept so the existing
// `leetcode.deleteCache` command and any callers stay valid.
export async function deleteCache(): Promise<void> {
    return;
}
