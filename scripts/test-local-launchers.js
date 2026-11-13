#!/usr/bin/env node
"use strict";

// Regression check for the local launcher scripts on Windows, where `npm` and
// `code` are `.cmd` shims that spawnSync cannot run without a shell. Run via
// `npm run test:launchers` so npm_execpath is set like `npm run local`.
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { commandExists, planSpawn } = require("./auth-sync-utils");

// Pure planning rules, checked on every platform.
const plain = planSpawn("code", ["a b"], "darwin");
assert.deepStrictEqual(plain, { command: "code", args: ["a b"], shell: false });
const exe = planSpawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--user-data-dir=C:\\x\\User Data"], "win32");
assert.strictEqual(exe.shell, false, "a real .exe must run without a shell");
const shim = planSpawn("C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd", ["--profile-directory=Profile 1", "a&b", "", "C:\\dir\\", "--force"], "win32");
assert.deepStrictEqual(shim, {
    command: "\"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd\"",
    args: ["\"--profile-directory=Profile 1\"", "\"a&b\"", "\"\"", "C:\\dir\\", "--force"],
    shell: true,
});
assert.strictEqual(planSpawn("code", ["C:\\Jane Doe\\dir\\"], "win32").args[0], "\"C:\\Jane Doe\\dir\\\\\"");
assert.throws(() => planSpawn("code", ["50%off"], "win32"), /Windows shell/);
assert.throws(() => planSpawn("\"%PATH%\"", [], "win32"), /Windows shell/);
assert.strictEqual(planSpawn("\"C:\\Program Files\\code.cmd\"", [], "win32").command, "\"C:\\Program Files\\code.cmd\"");
assert.strictEqual(planSpawn("code", ["\"C:\\dir\\\""], "win32").args[0], "C:\\dir\\");
assert.strictEqual(planSpawn("code", ["\"C:\\a b\\\""], "win32").args[0], "\"C:\\a b\\\\\"");
assert.throws(() => planSpawn("code", ["say \"hi\""], "win32"), /Windows shell/);

assert.ok(commandExists("npm"), "commandExists must find npm (npm.cmd on Windows)");
assert.ok(!commandExists("leetcode-launcher-check-missing-cli"), "commandExists must reject a missing CLI");

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "run this check through `npm run test:launchers`");
const result = spawnSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" });
assert.strictEqual(result.status, 0, `npm via npm_execpath failed: ${result.error || result.stderr}`);

// On Windows, prove the quoting end to end: run a .cmd shim from a directory
// with a space in its name and check the exact argv the target receives.
if (process.platform === "win32") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher check "));
    try {
        const shimPath = path.join(dir, "echo args.cmd");
        fs.writeFileSync(shimPath, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`);
        const args = ["--user-data-dir=C:\\x\\User Data", "a&b|c", "plain", "", "C:\\Jane Doe\\dir\\"];
        const plan = planSpawn(shimPath, args);
        const echoed = spawnSync(plan.command, plan.args, { shell: plan.shell, encoding: "utf8" });
        assert.strictEqual(echoed.status, 0, echoed.stderr);
        assert.deepStrictEqual(JSON.parse(echoed.stdout.trim()), args);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log("Local launcher checks passed.");
