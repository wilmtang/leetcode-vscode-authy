// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

const fs = require("fs");
const { commandExists, distPath, getCodeCommand, run, vsixPath } = require("./auth-sync-utils");

const codeCommand = getCodeCommand();

if (!commandExists(codeCommand)) {
    console.error(`Could not find the VS Code CLI command "${codeCommand}".`);
    console.error("Install it from VS Code: Command Palette > Shell Command: Install 'code' command in PATH.");
    console.error("Or set VSCODE_BIN=/absolute/path/to/code and run this script again.");
    process.exit(1);
}

fs.mkdirSync(distPath, { recursive: true });

console.log("Packaging VSIX with @vscode/vsce...");
run("npm", ["exec", "--yes", "--package", "@vscode/vsce", "--", "vsce", "package", "--out", vsixPath]);

console.log("Removing the old stock LeetCode extension ID if it is installed...");
run(codeCommand, ["--uninstall-extension", "leetcode.vscode-leetcode"], { allowFailure: true });

console.log("Removing the previous local auth-sync extension ID if it is installed...");
run(codeCommand, ["--uninstall-extension", "zihaod.vscode-leetcode-auth-sync"], { allowFailure: true });

console.log("Installing packaged VS Code extension...");
run(codeCommand, ["--install-extension", vsixPath, "--force"]);

console.log(`Installed ${vsixPath}`);
console.log("Reload VS Code, then run 'LeetCode: Show Browser Auth Sync Status' to confirm the listener.");
