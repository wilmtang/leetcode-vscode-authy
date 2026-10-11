#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "out");
const outputFile = path.join(outputDir, "extension.js");
const katexSourceDir = path.join(repoRoot, "node_modules", "katex", "dist");
const katexOutputDir = path.join(outputDir, "katex");

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(outputFile, { force: true });
fs.rmSync(katexOutputDir, { recursive: true, force: true });

esbuild.buildSync({
    entryPoints: [path.join(repoRoot, "src", "extension.ts")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node14",
    define: { "Object.hasOwn": "bundledHasOwn" },
    inject: [path.join(repoRoot, "src", "runtimeCompat.ts")],
    external: ["vscode"],
    sourcemap: false,
    minify: false,
    legalComments: "eof",
    logLevel: "info",
});

fs.mkdirSync(katexOutputDir, { recursive: true });
fs.copyFileSync(
    path.join(katexSourceDir, "katex.min.css"),
    path.join(katexOutputDir, "katex.min.css"),
);
fs.cpSync(
    path.join(katexSourceDir, "fonts"),
    path.join(katexOutputDir, "fonts"),
    { recursive: true },
);

console.log(`Bundled VS Code extension: ${path.relative(repoRoot, outputFile)}`);
console.log(`Copied KaTeX webview assets: ${path.relative(repoRoot, katexOutputDir)}`);
