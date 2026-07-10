// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

const { browserExtensionPath, repoRoot, vsixPath } = require("./auth-sync-utils");

console.log(`Repo: ${repoRoot}`);
console.log(`Browser extension unpacked path: ${browserExtensionPath}`);
console.log(`Packaged VSIX path: ${vsixPath}`);
