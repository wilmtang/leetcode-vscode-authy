#!/usr/bin/env node
"use strict";

// Regression check for the local launcher scripts on Windows, where `npm` and
// `code` are `.cmd` shims that spawnSync cannot run without a shell. Run via
// `npm run test:launchers` so npm_execpath is set like `npm run local`.
const assert = require("assert");
const { spawnSync } = require("child_process");
const { commandExists } = require("./auth-sync-utils");

assert.ok(commandExists("npm"), "commandExists must find npm (npm.cmd on Windows)");
assert.ok(!commandExists("leetcode-launcher-check-missing-cli"), "commandExists must reject a missing CLI");

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "run this check through `npm run test:launchers`");
const result = spawnSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" });
assert.strictEqual(result.status, 0, `npm via npm_execpath failed: ${result.error || result.stderr}`);

console.log("Local launcher checks passed.");
