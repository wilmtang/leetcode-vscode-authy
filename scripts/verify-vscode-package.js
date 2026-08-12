#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const bundlePath = path.join(repoRoot, packageJson.main);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const maximumPublishedFiles = 150;
// The selective Highlight.js/Lodash build is ~2.13 MiB. Keep a 0.87 MiB
// tolerance for normal feature growth without permitting the former 3.8 MiB
// root-distribution imports to return unnoticed.
const maximumBundleBytes = 3 * 1024 * 1024;

assertFile(bundlePath, "VS Code extension bundle");
assertFile(path.join(repoRoot, "out", "katex", "katex.min.css"), "KaTeX stylesheet");

const bundleSource = fs.readFileSync(bundlePath, "utf8");
const externalRequires = collectExternalRequires(bundleSource);
const allowedRequires = new Set([
    "vscode",
    ...Module.builtinModules,
    ...Module.builtinModules.map((name) => name.replace(/^node:/, "")),
]);
const unexpectedRequires = [...externalRequires].filter((name) => !allowedRequires.has(name));
if (unexpectedRequires.length > 0) {
    fail(`Bundle retains unexpected package imports: ${unexpectedRequires.join(", ")}`);
}

require(path.join(repoRoot, "src", "test", "support", "register-vscode.js"));
const extensionExports = require(bundlePath);
if (typeof extensionExports.activate !== "function" || typeof extensionExports.deactivate !== "function") {
    fail("Bundle does not load with the VS Code API stub or export activate/deactivate.");
}

const bundleBytes = fs.statSync(bundlePath).size;
if (bundleBytes > maximumBundleBytes) {
    fail(`Bundle is ${(bundleBytes / 1024 / 1024).toFixed(2)} MiB; limit is ${maximumBundleBytes / 1024 / 1024} MiB.`);
}

const result = cp.spawnSync(
    npmCommand,
    ["exec", "--", "vsce", "ls", "--no-dependencies"],
    { cwd: repoRoot, encoding: "utf8" },
);
if (result.error || result.status !== 0) {
    fail(result.error ? result.error.message : result.stderr || "vsce ls failed.");
}

const publishedFiles = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const mainPath = packageJson.main.replace(/^\.\//, "");
if (!publishedFiles.includes(mainPath)) {
    fail(`Package does not include its main entry: ${mainPath}`);
}
if (!publishedFiles.includes("out/katex/katex.min.css")) {
    fail("Package does not include the KaTeX stylesheet.");
}
if (!publishedFiles.some((file) => /^out\/katex\/fonts\/.+\.woff2$/.test(file))) {
    fail("Package does not include KaTeX web fonts.");
}

const forbiddenFiles = publishedFiles.filter((file) =>
    file.startsWith("node_modules/") ||
    file.startsWith("out/src/") ||
    file.startsWith("src/") ||
    file.startsWith("scripts/") ||
    file.startsWith("docs/") ||
    /(^|\/)\.env(?:\.|$)/.test(file) ||
    /\.log$/i.test(file),
);
if (forbiddenFiles.length > 0) {
    fail(`Package contains forbidden development/local files: ${forbiddenFiles.slice(0, 10).join(", ")}`);
}
if (publishedFiles.length > maximumPublishedFiles) {
    fail(`Package contains ${publishedFiles.length} files; limit is ${maximumPublishedFiles}.`);
}

console.log(
    `VSIX content contract verified: ${publishedFiles.length} extension files, ` +
    `${(bundleBytes / 1024 / 1024).toFixed(2)} MiB runtime bundle, no packaged node_modules.`,
);

function collectExternalRequires(source) {
    const names = new Set();
    const pattern = /\brequire\("([^"]+)"\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        names.add(match[1]);
    }
    return names;
}

function assertFile(filePath, label) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        fail(`${label} is missing: ${path.relative(repoRoot, filePath)}`);
    }
}

function fail(message) {
    console.error(message);
    process.exit(1);
}
