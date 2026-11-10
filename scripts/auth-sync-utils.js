// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const browserExtensionPath = path.join(repoRoot, "browser-extension");
const distPath = path.join(repoRoot, "dist");
const vsixPath = path.join(distPath, "vscode-leetcode-auth-sync.vsix");

// On Windows, CLIs such as `code` and `npm` are `.cmd` shims: without a shell,
// spawnSync neither resolves them via PATHEXT nor (on patched Node) runs them.
// A real `.exe` (e.g. chrome.exe) runs directly, with no shell. When cmd.exe is
// needed, Node joins the command and arguments with plain spaces, so every word
// that contains whitespace or a cmd delimiter/operator is double-quoted here
// (`C:\Users\Jane Doe\...`, `--user-data-dir=...\User Data`). Inside quotes
// cmd treats `& | < > ^ ( )` literally; `"` and `%` cannot be made literal, so
// they are rejected instead of being reinterpreted by the shell.
function planSpawn(command, args, platform = process.platform) {
    if (platform !== "win32" || /\.exe$/i.test(command)) {
        return { command, args, shell: false };
    }
    return { command: quoteForCmd(command), args: args.map(quoteForCmd), shell: true };
}

function quoteForCmd(value) {
    let text = String(value);
    // An already-quoted value (e.g. VSCODE_BIN="C:\Program Files\...") is
    // unwrapped and checked like any other.
    if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
        text = text.slice(1, -1);
    }
    if (/["%\r\n]/.test(text)) {
        throw new Error(`Cannot pass this value through the Windows shell safely: ${text}`);
    }
    if (text !== "" && !/[\s&|<>^(),;=!]/.test(text)) {
        return text;
    }
    // The target's argv parser treats `\"` as an escaped quote, so double any
    // trailing backslashes before the closing quote (`"C:\dir\\"` -> C:\dir\).
    return `"${text.replace(/(\\+)$/, "$1$1")}"`;
}

function commandExists(command) {
    const plan = planSpawn(command, ["--version"]);
    const result = spawnSync(plan.command, plan.args, { stdio: "ignore", shell: plan.shell });
    return result.status === 0;
}

function run(command, args, options = {}) {
    const { allowFailure, ...spawnOptions } = options;
    const plan = planSpawn(command, args);
    const result = spawnSync(plan.command, plan.args, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: plan.shell,
        ...spawnOptions,
    });

    if (result.status !== 0 && !allowFailure) {
        process.exit(result.status || 1);
    }
}

function getCodeCommand() {
    if (process.env.VSCODE_BIN) {
        return process.env.VSCODE_BIN;
    }

    return "code";
}

function findChromeBinary() {
    if (process.env.CHROME_BIN) {
        return process.env.CHROME_BIN;
    }

    const candidates = process.platform === "darwin"
        ? [
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          ]
        : process.platform === "win32"
        ? [
              path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
              path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
              path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : [
              "google-chrome",
              "google-chrome-stable",
              "chromium",
              "chromium-browser",
          ];

    return candidates.find((candidate) => {
        if (candidate.includes(path.sep)) {
            return fs.existsSync(candidate);
        }

        return commandExists(candidate);
    });
}

function getDefaultChromeUserDataDir() {
    if (process.env.CHROME_USER_DATA_DIR) {
        return process.env.CHROME_USER_DATA_DIR;
    }

    if (process.env.AUTH_SYNC_CHROME_USER_DATA_DIR) {
        return process.env.AUTH_SYNC_CHROME_USER_DATA_DIR;
    }

    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    }

    if (process.platform === "win32") {
        return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
    }

    return path.join(os.homedir(), ".config", "google-chrome");
}

function getLastUsedChromeProfileDirectory(userDataDir) {
    if (process.env.CHROME_PROFILE_DIRECTORY) {
        return process.env.CHROME_PROFILE_DIRECTORY;
    }

    const localStatePath = path.join(userDataDir, "Local State");
    try {
        const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
        if (typeof localState.profile?.last_used === "string") {
            return localState.profile.last_used;
        }
    } catch (error) {
        return "Default";
    }

    return "Default";
}

module.exports = {
    browserExtensionPath,
    commandExists,
    distPath,
    findChromeBinary,
    getDefaultChromeUserDataDir,
    getLastUsedChromeProfileDirectory,
    getCodeCommand,
    planSpawn,
    repoRoot,
    run,
    vsixPath,
};
