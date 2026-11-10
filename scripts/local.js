#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");

const isWindows = process.platform === "win32";
const nodeCmd = process.execPath;

// Run npm without a shell. Under `npm run local`, npm_execpath names npm's own
// JS entry point, so it runs with this Node on every OS. Spawning `npm.cmd`
// directly fails with EINVAL on patched Windows Node releases, so the fallback
// (invoked as `node scripts/local.js`) goes through the shell there.
function npmStep(args) {
    const npmCli = process.env.npm_execpath;
    if (npmCli && /\.[cm]?js$/i.test(npmCli)) {
        return [nodeCmd, [npmCli, ...args]];
    }
    return ["npm", args, { shell: isWindows }];
}

const localCommands = {
    "hooks": {
        description: "Point Git at this repo's local pre-commit hook.",
        steps: [["git", ["config", "core.hooksPath", "scripts/git-hooks"]]],
    },
    "vscode:dev": {
        description: "Compile and launch a VS Code extension-development host.",
        steps: [npmStep(["run", "vscode:prepublish"]), [nodeCmd, ["scripts/start-vscode-auth-sync-dev.js"]]],
    },
    "vscode:install": {
        description: "Compile, package, and install the extension into local VS Code.",
        steps: [[nodeCmd, ["scripts/install-vscode-auth-sync-extension.js"]]],
    },
    "chrome:dev": {
        description: "Launch Chrome with the unpacked browser extension.",
        steps: [[nodeCmd, ["scripts/start-chrome-auth-sync-extension.js"]]],
    },
    "chrome:dev-current": {
        description: "Launch Chrome with the unpacked browser extension and current profile.",
        steps: [[nodeCmd, ["scripts/start-chrome-auth-sync-extension.js", "--profile=current"]]],
    },
    "paths": {
        description: "Print useful local extension/build paths.",
        steps: [[nodeCmd, ["scripts/print-auth-sync-paths.js"]]],
    },
    "icons": {
        description: "Regenerate browser-extension PNG icons from the SVG source.",
        steps: [[nodeCmd, ["scripts/generate-browser-extension-icons.js"]]],
    },
};

const scriptNotes = [
    ["vscode:prepublish", "VSCE lifecycle hook. Type-checks, bundles, and copies runtime assets before package/publish."],
    ["build", "Packages the VS Code extension VSIX; it also triggers vscode:prepublish."],
    ["release:vscode:local", "Local release dry-run: lint first, then package dist/vscode-leetcode-auth-sync.vsix."],
    ["publish:vscode:marketplace", "Publish a prepared VSIX to the Microsoft VS Code Marketplace."],
    ["publish:vscode:open-vsx", "Publish a prepared VSIX to the Open VSX Registry."],
    ["auth-sync:*", "Browser-extension validation/build/publish scripts used by GitHub Actions."],
];

function printHelp() {
    console.log(`Usage:
  npm run local -- <command>
  npm run scripts:help

Local commands:`);

    for (const [name, command] of Object.entries(localCommands)) {
        console.log(`  ${name.padEnd(18)} ${command.description}`);
    }

    console.log("\nScript notes:");
    for (const [name, description] of scriptNotes) {
        console.log(`  ${name.padEnd(28)} ${description}`);
    }
}

function runStep(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
    if (result.error) {
        console.error(result.error.message);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

const commandName = process.argv[2];

if (!commandName || commandName === "-h" || commandName === "--help") {
    printHelp();
    process.exit(commandName ? 0 : 1);
}

const command = localCommands[commandName];
if (!command) {
    console.error(`Unknown local command: ${commandName}\n`);
    printHelp();
    process.exit(1);
}

for (const [commandPath, args, options] of command.steps) {
    runStep(commandPath, args, options);
}
