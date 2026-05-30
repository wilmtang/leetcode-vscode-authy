// Copyright (c) wilmtang. All rights reserved.
// Licensed under the MIT license.

const { commandExists, getCodeCommand, repoRoot, run } = require("./auth-sync-utils");

const codeCommand = getCodeCommand();

if (!commandExists(codeCommand)) {
    console.error(`Could not find the VS Code CLI command "${codeCommand}".`);
    console.error("Install it from VS Code: Command Palette > Shell Command: Install 'code' command in PATH.");
    console.error("Or set VSCODE_BIN=/absolute/path/to/code and run this script again.");
    process.exit(1);
}

console.log("Opening VS Code with this checkout as an extension-development host.");
console.log("The auth-sync server starts after extension activation and listens on 127.0.0.1:17899 by default.");

run(codeCommand, ["--new-window", "--extensionDevelopmentPath", repoRoot, repoRoot]);
