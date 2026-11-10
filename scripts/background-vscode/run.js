#!/usr/bin/env node
// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Background VS Code check: runs the built extension in a throwaway VS Code
// instance on the non-primary built-in display, without activating it, and
// drives/screenshots it over the Chrome DevTools Protocol instead of the real
// pointer or keyboard. See AGENTS.md "Background VS Code checks".
//
//   npm run bundle && node scripts/background-vscode/run.js [--scenario status-bar] [--out DIR] [--keep-open]
//
// Guarantees: refuses unless macOS has a non-primary, unmirrored built-in
// display; launches with activation disabled into an isolated user-data and
// extensions dir (the user's real profile, extensions and settings are never
// read or written); uses its own auth-sync port so the user's running VS Code
// keeps its sync; aborts if the window does not land on that display or if the
// frontmost app changes; always terminates only the PID it launched and
// removes its temp dirs, even on failure.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const HELPER = path.join(__dirname, "macos-window.swift");
const CODE_APP = process.env.VSCODE_APP || "/Applications/Visual Studio Code.app";
const EXTENSION_ID = "wilmtang.vscode-leetcode-auth-sync";

function parseArgs(argv) {
    const options = { scenario: "status-bar", out: undefined, keepOpen: false, unhide: true };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--scenario") { options.scenario = argv[++i]; }
        else if (argv[i] === "--out") { options.out = path.resolve(argv[++i]); }
        else if (argv[i] === "--keep-open") { options.keepOpen = true; }
        else if (argv[i] === "--no-unhide") { options.unhide = false; }
        else { throw new Error(`Unknown argument: ${argv[i]}`); }
    }
    return options;
}

function helper(...args) {
    const result = childProcess.spawnSync("swift", [HELPER, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || `helper ${args[0]} failed`).trim());
    }
    return result.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, probe, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await probe();
            if (last) { return last; }
        } catch (error) {
            last = error.message;
        }
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// ---- Isolated profile ------------------------------------------------------

function prepareProfile(root, display, syncPort) {
    const userData = path.join(root, "user-data");
    const workspace = path.join(root, "workspace");
    const harness = path.join(root, "harness");
    fs.mkdirSync(path.join(userData, "User", "globalStorage"), { recursive: true });
    fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(workspace, "README.md"), "Background VS Code check workspace.\n");

    fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
        "leetcode.authSync.port": syncPort,
        "window.restoreWindows": "all",
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "security.workspace.trust.enabled": false,
        "chat.disableAIFeatures": true,
    }, null, 4));

    // VS Code restores a window's last bounds when reopening the same folder,
    // so seeding them is how the window opens directly on the test display.
    const margin = 40;
    const width = Math.min(1600, display.width - 2 * margin);
    const height = Math.min(1000, display.height - 2 * margin);
    const uiState = { mode: 1, x: display.x + margin, y: display.y + margin, width, height };
    const folderUri = `file://${encodeURI(workspace)}`;
    fs.writeFileSync(path.join(userData, "User", "globalStorage", "storage.json"), JSON.stringify({
        windowsState: {
            lastActiveWindow: { folder: folderUri, uiState },
            openedWindows: [{ folder: folderUri, uiState }],
        },
    }, null, 4));

    writeHarnessExtension(harness, path.join(root, "ipc"));
    fs.mkdirSync(path.join(root, "ipc"), { recursive: true });
    return { userData, workspace, harness, extensions: path.join(root, "extensions"), ipc: path.join(root, "ipc") };
}

// A tiny development extension that runs commands for the driver inside the
// extension host (config changes, commands, port blockers). It reads numbered
// request files and writes matching replies, so no pointer or keyboard input is
// ever needed.
function writeHarnessExtension(dir, ipcDir) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "background-vscode-harness",
        publisher: "local",
        version: "0.0.0",
        engines: { vscode: "^1.57.0" },
        activationEvents: ["*"],
        main: "./extension.js",
    }, null, 4));
    fs.writeFileSync(path.join(dir, "extension.js"), `"use strict";
const vscode = require("vscode");
const fs = require("fs");
const net = require("net");
const path = require("path");
const IPC = ${JSON.stringify(ipcDir)};
const blockers = new Map();
async function handle(request) {
    switch (request.op) {
        case "ping":
            return { ok: true, extension: !!vscode.extensions.getExtension(${JSON.stringify(EXTENSION_ID)}) };
        case "activate": {
            const ext = vscode.extensions.getExtension(${JSON.stringify(EXTENSION_ID)});
            await ext.activate();
            return { ok: ext.isActive };
        }
        case "config":
            await vscode.workspace.getConfiguration().update(request.key, request.value, vscode.ConfigurationTarget.Global);
            return { ok: true };
        case "command":
            // Quick picks resolve only when closed, so do not await them.
            if (request.wait) { await vscode.commands.executeCommand(request.id, ...(request.args || [])); }
            else { void vscode.commands.executeCommand(request.id, ...(request.args || [])); }
            return { ok: true };
        case "block": {
            const server = net.createServer((socket) => socket.destroy());
            await new Promise((resolve, reject) => { server.once("error", reject); server.listen(request.port, "127.0.0.1", resolve); });
            blockers.set(request.port, server);
            return { ok: true };
        }
        case "unblock": {
            const server = blockers.get(request.port);
            if (server) { await new Promise((resolve) => server.close(resolve)); blockers.delete(request.port); }
            return { ok: true };
        }
        default:
            return { ok: false, error: "unknown op " + request.op };
    }
}
function activate(context) {
    let busy = false;
    const timer = setInterval(async () => {
        if (busy) { return; }
        busy = true;
        try {
            for (const name of fs.readdirSync(IPC).filter((n) => /^req-\\d+\\.json$/.test(n)).sort()) {
                const file = path.join(IPC, name);
                const request = JSON.parse(fs.readFileSync(file, "utf8"));
                fs.unlinkSync(file);
                let reply;
                try { reply = await handle(request); } catch (error) { reply = { ok: false, error: String(error) }; }
                fs.writeFileSync(path.join(IPC, name.replace("req-", "res-")), JSON.stringify(reply));
            }
        } catch (error) {
            // Directory removed during teardown.
        } finally {
            busy = false;
        }
    }, 100);
    context.subscriptions.push({ dispose() { clearInterval(timer); for (const s of blockers.values()) { s.close(); } } });
}
module.exports = { activate, deactivate() {} };
`);
}

let requestSeq = 0;
async function harness(ipc, request, timeoutMs = 15000) {
    const id = String(++requestSeq).padStart(4, "0");
    fs.writeFileSync(path.join(ipc, `req-${id}.json.tmp`), JSON.stringify(request));
    fs.renameSync(path.join(ipc, `req-${id}.json.tmp`), path.join(ipc, `req-${id}.json`));
    const resFile = path.join(ipc, `res-${id}.json`);
    const reply = await waitFor(`harness ${request.op}`, () => fs.existsSync(resFile) && JSON.parse(fs.readFileSync(resFile, "utf8")), timeoutMs, 100);
    if (!reply.ok) { throw new Error(`harness ${request.op} failed: ${reply.error || JSON.stringify(reply)}`); }
    return reply;
}

// ---- CDP ------------------------------------------------------------------------

class Cdp {
    static async connect(port) {
        const target = await waitFor("workbench CDP target", async () => {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            return list.find((t) => t.type === "page" && /workbench/.test(t.url));
        }, 60000, 500);
        const cdp = new Cdp(new WebSocket(target.webSocketDebuggerUrl));
        await new Promise((resolve, reject) => { cdp.ws.onopen = resolve; cdp.ws.onerror = reject; });
        return cdp;
    }

    constructor(ws) {
        this.ws = ws;
        this.seq = 0;
        this.pending = new Map();
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            const waiter = this.pending.get(message.id);
            if (waiter) {
                this.pending.delete(message.id);
                if (message.error) { waiter.reject(new Error(message.error.message)); } else { waiter.resolve(message.result); }
            }
        };
    }

    send(method, params = {}) {
        const id = ++this.seq;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) { throw new Error(result.exceptionDetails.text); }
        return result.result.value;
    }

    async screenshot(file, clip) {
        const params = { format: "png", captureBeyondViewport: false };
        if (clip) { params.clip = { ...clip, scale: 1 }; }
        const { data } = await this.send("Page.captureScreenshot", params);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        return file;
    }

    close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

// ---- Status bar scenario --------------------------------------------------------

const STATUS_ITEMS_JS = `(() => {
    const items = [...document.querySelectorAll(".statusbar-item")].filter((el) => /leetcode/i.test(el.id) || /LeetCode/.test(el.getAttribute("aria-label") || ""));
    return items.map((el) => {
        const label = el.querySelector("a, .statusbar-item-label") || el;
        const style = getComputedStyle(el);
        return {
            id: el.id,
            text: label.textContent.trim(),
            icons: [...el.querySelectorAll(".codicon")].map((i) => [...i.classList].filter((c) => c.startsWith("codicon-")).join(" ")),
            aria: (label.getAttribute("aria-label") || el.getAttribute("aria-label") || ""),
            background: style.backgroundColor,
            hidden: el.offsetParent === null || style.display === "none",
            rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
        };
    });
})()`;

const QUICK_PICK_JS = `(() => {
    const widget = document.querySelector(".quick-input-widget");
    if (!widget || widget.style.display === "none" || widget.offsetParent === null) { return null; }
    const input = widget.querySelector("input");
    const rows = [...widget.querySelectorAll(".monaco-list-row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim());
    const r = widget.getBoundingClientRect();
    return { placeholder: input ? input.getAttribute("placeholder") : "", rows, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
})()`;

async function statusBarClip(cdp) {
    const bar = await cdp.evaluate(`(() => { const r = document.querySelector(".part.statusbar").getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 900), height: r.height }; })()`);
    return bar;
}

async function runStatusBarScenario(ctx) {
    const { cdp, ipc, out, results } = ctx;
    const syncItem = async () => (await cdp.evaluate(STATUS_ITEMS_JS)).find((i) => /sessionSync/.test(i.id));
    const accountItem = async () => (await cdp.evaluate(STATUS_ITEMS_JS)).find((i) => /status\.account/.test(i.id));

    async function capture(name) {
        const items = await cdp.evaluate(STATUS_ITEMS_JS);
        const quickPick = await cdp.evaluate(QUICK_PICK_JS);
        const files = [await cdp.screenshot(path.join(out, `${name}-statusbar.png`), await statusBarClip(cdp))];
        if (quickPick) {
            const r = quickPick.rect;
            files.push(await cdp.screenshot(path.join(out, `${name}-quickpick.png`), { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }));
        }
        results.push({ step: name, items, quickPick, files });
        console.log(`[${name}]`, JSON.stringify({ items: items.map((i) => ({ id: i.id, text: i.text, icons: i.icons, hidden: i.hidden, background: i.background, aria: i.aria })), quickPick }, null, 0));
    }

    async function openActions() {
        await harness(ipc, { op: "command", id: "leetcode.authSync.showActions" });
        await waitFor("session sync quick pick", () => cdp.evaluate(QUICK_PICK_JS), 10000);
    }
    async function closeQuickPick() {
        await harness(ipc, { op: "command", id: "workbench.action.closeQuickOpen", wait: true });
        await waitFor("quick pick closed", async () => !(await cdp.evaluate(QUICK_PICK_JS)), 5000);
    }

    // 1. Local: this window owns sync on its private port.
    await waitFor("sync item visible", async () => { const i = await syncItem(); return i && !i.hidden && i; }, 30000);
    await capture("01-local");
    await openActions();
    await capture("02-local-actions");
    await closeQuickPick();

    // 2. Click the item through the DOM (no real pointer) to prove it opens the same pick.
    await cdp.evaluate(`document.getElementById(${JSON.stringify((await syncItem()).id)}).querySelector("a, .statusbar-item-label").click()`);
    await waitFor("quick pick from click", () => cdp.evaluate(QUICK_PICK_JS), 10000);
    await capture("03-click-opens-actions");
    await closeQuickPick();

    // 3. Conflict: occupy a second port, then point sync at it.
    const blocked = await freePort();
    await harness(ipc, { op: "block", port: blocked });
    await harness(ipc, { op: "config", key: "leetcode.authSync.port", value: blocked });
    await waitFor("conflict state", async () => { const i = await syncItem(); return i && /Sync blocked/.test(i.text) && i; }, 20000);
    await capture("04-conflict");
    await openActions();
    await capture("05-conflict-actions");
    await closeQuickPick();

    // 4. Freeing the port and restarting returns to local without a stopped flash.
    await harness(ipc, { op: "unblock", port: blocked });
    const seen = [];
    const recorder = setInterval(async () => { try { const i = await syncItem(); if (i) { seen.push(i.text || i.icons.join(",")); } } catch (_) { /* ignore */ } }, 50);
    await harness(ipc, { op: "command", id: "leetcode.authSync.restart", wait: false });
    await waitFor("local after restart", async () => { const i = await syncItem(); return i && i.icons.some((c) => /codicon-sync\b/.test(c)) && !i.text && i; }, 20000);
    await sleep(300);
    clearInterval(recorder);
    results.push({ step: "06-restart-trace", seen });
    console.log("[06-restart-trace]", JSON.stringify([...new Set(seen)]));
    if (seen.some((s) => /stopped/i.test(s))) { throw new Error(`restart showed a stopped state: ${JSON.stringify(seen)}`); }
    await capture("06-after-restart");

    // 5. Disabled: the sync item hides, the account item stays.
    await harness(ipc, { op: "config", key: "leetcode.authSync.enabled", value: false });
    await waitFor("sync item hidden", async () => { const i = await syncItem(); return (!i || i.hidden) && "hidden"; }, 20000);
    if (!(await accountItem())) { throw new Error("account item disappeared with sync disabled"); }
    await capture("07-disabled");
}

// ---- Main -------------------------------------------------------------------------

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (process.platform !== "darwin") { throw new Error("Background VS Code checks need macOS with a secondary built-in display."); }
    if (!fs.existsSync(path.join(REPO, "out", "extension.js"))) { throw new Error("Run `npm run bundle` first."); }
    if (typeof WebSocket !== "function") { throw new Error("Node with a global WebSocket (22+) is required."); }

    const [x, y, width, height] = helper("display").split(/\s+/).map(Number);
    const display = { x, y, width, height };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-bg-vscode-"));
    const out = options.out || path.join(root, "evidence");
    fs.mkdirSync(out, { recursive: true });
    const syncPort = await freePort();
    const cdpPort = await freePort();
    const profile = prepareProfile(root, display, syncPort);
    let pid;
    // Sample the frontmost app for the whole run. Another app becoming
    // frontmost is the user working; the launched instance becoming frontmost
    // is a focus steal and fails the run.
    const frontmostSamples = new Set();
    let stealDetected = false;
    let phase = "launch";
    const stealPhases = new Set();
    const focusWatch = setInterval(() => {
        try {
            const front = helper("frontmost");
            frontmostSamples.add(front);
            if (pid && front === String(pid)) { stealDetected = true; stealPhases.add(phase); }
        } catch (_) { /* ignore a failed sample */ }
    }, 500);
    let cdp;
    const results = [];
    try {
        pid = Number(helper("launch", CODE_APP,
            `--user-data-dir=${profile.userData}`,
            `--extensions-dir=${profile.extensions}`,
            "--disable-extensions",
            "--skip-welcome",
            "--skip-release-notes",
            "--disable-workspace-trust",
            `--extensionDevelopmentPath=${REPO}`,
            `--extensionDevelopmentPath=${profile.harness}`,
            `--remote-debugging-port=${cdpPort}`,
            profile.workspace));
        console.log(`Launched VS Code pid ${pid} (CDP ${cdpPort}, sync port ${syncPort}) into ${root}`);

        const window = await waitFor("VS Code window", () => {
            const line = helper("windows", String(pid)).split("\n").find(Boolean);
            if (!line) { return undefined; }
            const [id, wx, wy, ww, wh] = line.split(/\s+/).map(Number);
            return { id, x: wx, y: wy, width: ww, height: wh };
        }, 60000, 250);
        const cx = window.x + window.width / 2;
        const cy = window.y + window.height / 2;
        if (cx < display.x || cx > display.x + display.width || cy < display.y || cy > display.y + display.height) {
            throw new Error(`Window opened at ${JSON.stringify(window)}, not on the test display ${JSON.stringify(display)}; aborted.`);
        }
        console.log(`Window ${window.id} on the test display at ${window.x},${window.y} ${window.width}x${window.height}`);
        phase = "unhide";
        if (options.unhide) {
            console.log(`unhide: ${helper("unhide", String(pid))}`);
        }
        await sleep(1500);
        phase = "scenario";

        cdp = await Cdp.connect(cdpPort);
        await waitFor("harness", () => harness(profile.ipc, { op: "ping" }, 2000).then((r) => r.extension && r), 60000, 500);
        await harness(profile.ipc, { op: "activate" }, 60000);

        if (options.scenario === "status-bar") {
            await runStatusBarScenario({ cdp, ipc: profile.ipc, out, results });
        } else {
            throw new Error(`Unknown scenario ${options.scenario}`);
        }

        fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ display, window, frontmostSamples: [...frontmostSamples], results }, null, 2));
        if (stealDetected) {
            throw new Error(`Focus steal: the test instance (pid ${pid}) became the frontmost app during: ${[...stealPhases].join(", ")}.`);
        }
        console.log(`Focus: the test instance never became frontmost (sampled every 500 ms; frontmost pids seen: ${[...frontmostSamples].join(", ")}).`);
        console.log(`Evidence: ${out}`);
        if (options.keepOpen) {
            console.log(`--keep-open: leaving pid ${pid} running. Stop it with: kill ${pid}`);
            pid = undefined;
        }
    } finally {
        clearInterval(focusWatch);
        if (cdp) { cdp.close(); }
        if (pid) {
            try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ }
            await waitFor("VS Code exit", () => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 15000, 200)
                .catch(() => { try { process.kill(pid, "SIGKILL"); } catch (_) { /* ignore */ } });
        }
        if (!options.keepOpen) {
            const keep = options.out ? undefined : out;
            for (const entry of fs.readdirSync(root)) {
                if (path.join(root, entry) !== keep) { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); }
            }
            if (!keep) { fs.rmdirSync(root); }
        }
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
