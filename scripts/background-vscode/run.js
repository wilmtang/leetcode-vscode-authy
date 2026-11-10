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
//       [--allow-visible]   (debugging only, with the user's explicit OK: skips the
//                            prohibited policy and unhides the window, so it can
//                            take focus)
//
// Guarantees: refuses unless macOS has a non-primary, unmirrored built-in
// display; launches hidden with activation disabled, then pauses the main
// process and sets a "prohibited" activation policy before any window exists,
// so macOS cannot activate it; runs in an isolated user-data and
// extensions dir (the user's real profile, extensions and settings are never
// read or written); uses its own auth-sync port so the user's running VS Code
// keeps its sync; aborts if the window does not land on that display or if the
// launched instance ever activates; terminates only the PID it launched and
// removes its temp dirs on failure, on Ctrl-C/SIGTERM/SIGHUP, and (for a run
// killed outright) at the start of the next run.

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
    const options = { scenario: "status-bar", out: undefined, keepOpen: false, allowVisible: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--scenario") { options.scenario = argv[++i]; }
        else if (argv[i] === "--out") { options.out = path.resolve(argv[++i]); }
        else if (argv[i] === "--keep-open") { options.keepOpen = true; }
        else if (argv[i] === "--allow-visible") { options.allowVisible = true; }
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

async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.json();
}

function openSocket(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { try { ws.close(); } catch (_) { /* ignore */ } reject(new Error(`WebSocket ${url} did not open in ${timeoutMs} ms`)); }, timeoutMs);
        ws.onopen = () => { clearTimeout(timer); resolve(ws); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error(`WebSocket ${url} failed to open`)); };
    });
}

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
            const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
            return list.find((t) => t.type === "page" && /workbench/.test(t.url));
        }, 60000, 500);
        return new Cdp(await openSocket(target.webSocketDebuggerUrl));
    }

    constructor(ws) {
        this.ws = ws;
        this.seq = 0;
        this.pending = new Map();
        ws.onmessage = (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            if (message.method === "Debugger.paused" && this.onPaused) { this.onPaused(message.params); }
            const waiter = this.pending.get(message.id);
            if (waiter) {
                this.pending.delete(message.id);
                if (message.error) { waiter.reject(new Error(message.error.message)); } else { waiter.resolve(message.result); }
            }
        };
    }

    send(method, params = {}, timeoutMs = 20000) {
        const id = ++this.seq;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
        });
    }

    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
            throw new Error(detail || result.exceptionDetails.text);
        }
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

// ---- Main-process focus guard ----------------------------------------------------
//
// VS Code (Electron) activates itself when its window opens, from native code,
// which overrides a non-activating launch; patching the JS focus/show calls
// alone did not stop it. The release build keeps Electron's
// EnableNodeCliInspectArguments fuse on, so the main process starts with
// --inspect-brk. Once Node pauses on the first line of the main script (before
// any window exists) the guard runs on that paused frame and:
//   - sets the activation policy (default "prohibited": macOS then refuses to
//     activate the app or show its windows; the workbench still renders and CDP
//     still captures it),
//   - makes app.focus and window focus/moveTop no-ops and window show() inactive.
// Evaluating before the pause hangs (no execution context yet). The guard also
// checks that the inspector belongs to the launched pid. If anything fails the
// process is SIGKILLed while still paused and attached: detaching the last
// inspector session resumes a paused process, so it must die first.

const FOCUS_GUARD_JS = (policy) => `(() => {
    const binding = process._linkedBinding;
    const app = binding("electron_browser_app").app;
    const BaseWindow = binding("electron_browser_base_window").BaseWindow;
    const noop = function () { return undefined; };
    app.focus = noop;
    BaseWindow.prototype.focus = noop;
    BaseWindow.prototype.moveTop = noop;
    BaseWindow.prototype.show = function () { return this.showInactive(); };
    if (${JSON.stringify(policy)} !== "none") {
        app.setActivationPolicy(${JSON.stringify(policy)});
        // Pin it: later code must not switch back to a regular, activatable app.
        app.setActivationPolicy = noop;
    }
    return { patched: true };
})()`;

async function guardMainProcess(inspectPort, policy, pid) {
    const step = (name) => process.env.BG_VSCODE_DEBUG && console.log(`  guard: ${name}`);
    let inspector;
    try {
        const target = await waitFor("main-process inspector", async () => {
            const list = await fetchJson(`http://127.0.0.1:${inspectPort}/json/list`);
            return list.find((t) => t.webSocketDebuggerUrl);
        }, 30000, 200);
        inspector = new Cdp(await openSocket(target.webSocketDebuggerUrl));
        // Release the --inspect-brk wait; Node then pauses on the first line of
        // the main script, before any window exists. Patch while paused.
        let pausedResolve;
        const pausedEvent = new Promise((resolve) => { pausedResolve = resolve; });
        inspector.onPaused = (params) => pausedResolve(params);
        step("Runtime.enable");
        await inspector.send("Runtime.enable");
        step("Debugger.enable");
        await inspector.send("Debugger.enable");
        step("runIfWaitingForDebugger");
        await inspector.send("Runtime.runIfWaitingForDebugger");
        let pauseTimer;
        const paused = await Promise.race([
            pausedEvent,
            new Promise((resolve) => { pauseTimer = setTimeout(() => resolve(undefined), 20000); }),
        ]);
        clearTimeout(pauseTimer);
        if (!paused) { throw new Error("main process never paused on its first line"); }
        // Identify the process before changing anything: a port race could have
        // connected us to someone else's debuggable process, which must be left
        // exactly as it was.
        step("check pid on paused frame");
        const identity = await inspector.send("Debugger.evaluateOnCallFrame", {
            callFrameId: paused.callFrames[0].callFrameId,
            expression: "process.pid",
            returnByValue: true,
        });
        const inspectedPid = identity.result && identity.result.value;
        if (inspectedPid !== pid) {
            throw new Error(`inspector on port ${inspectPort} belongs to pid ${inspectedPid}, not the launched pid ${pid}; left it untouched`);
        }
        step("evaluate patch on paused frame");
        const evaluation = await inspector.send("Debugger.evaluateOnCallFrame", {
            callFrameId: paused.callFrames[0].callFrameId,
            expression: FOCUS_GUARD_JS(policy),
            returnByValue: true,
        });
        const value = evaluation.result && evaluation.result.value;
        if (evaluation.exceptionDetails || !value || value.patched !== true) {
            const detail = evaluation.exceptionDetails && evaluation.exceptionDetails.exception && evaluation.exceptionDetails.exception.description;
            throw new Error(`focus guard failed: ${detail || JSON.stringify(evaluation.result)}`);
        }
        if (process.env.BG_VSCODE_SELFTEST_GUARD_FAIL) {
            // Self-test for the failure path: the process must die while paused.
            throw new Error("self-test: forced guard failure");
        }
        inspector.onPaused = () => { void inspector.send("Debugger.resume", {}, 3000).catch(() => undefined); };
        step("resume");
        await inspector.send("Debugger.resume");
        await inspector.send("Debugger.disable", {}, 3000).catch(() => undefined);
        step("done");
    } catch (error) {
        killNow(pid);
        throw error;
    } finally {
        if (inspector) { inspector.close(); }
    }
}

function killNow(pid) {
    try { process.kill(pid, "SIGKILL"); } catch (_) { /* already gone */ }
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
    try {
        await harness(ipc, { op: "command", id: "leetcode.authSync.restart", wait: false });
        await waitFor("local after restart", async () => { const i = await syncItem(); return i && i.icons.some((c) => /codicon-sync\b/.test(c)) && !i.text && i; }, 20000);
        await sleep(300);
    } finally {
        clearInterval(recorder);
    }
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

const ROOT_PREFIX = "lc-bg-vscode-";

// A run killed outright (SIGKILL, closed terminal) cannot clean up after
// itself, and its prohibited instance has no Dock icon or window for the user to
// quit. Reap such leftovers: only a process whose command line still names that
// run's own profile directory is killed.
function reapStaleRuns() {
    const processes = (childProcess.spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "").split("\n");
    for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(ROOT_PREFIX))) {
        const dir = path.join(os.tmpdir(), name);
        const owner = path.join(dir, "runner.pid");
        const runner = fs.existsSync(owner) ? Number(fs.readFileSync(owner, "utf8")) : undefined;
        let runnerAlive = false;
        if (runner) { try { process.kill(runner, 0); runnerAlive = true; } catch (_) { /* gone */ } }
        if (runnerAlive) { continue; }
        // A concurrent run may not have written runner.pid yet.
        if (!runner && Date.now() - fs.statSync(dir).mtimeMs < 10000) { continue; }
        // Match by command line rather than a pid file, which a runner killed
        // during launch may never have written.
        const profileDir = path.join(dir, "user-data");
        const stale = processes.filter((line) => line.includes(profileDir)).map((line) => Number(line.trim().split(/\s+/)[0]));
        for (const stalePid of stale) {
            console.log(`Reaping stale background VS Code process ${stalePid} from ${dir}`);
            killNow(stalePid);
        }
        if (stale.length > 0) { killAndWait(undefined, profileDir); }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Long-running, event-driven activation watcher (one Swift process for the
// whole run, so it never blocks Node and cannot miss a brief activation).
// Resolves only once the watcher has printed its first line (it is then
// subscribed); an early exit is recorded so a dead watcher can never turn
// into a vacuous "never activated".
function watchActivations(timeoutMs = 30000) {
    // stdin is a pipe the watcher reads to EOF: if this process dies, even by
    // SIGKILL, the pipe closes and the watcher exits.
    const child = childProcess.spawn("swift", [HELPER, "watch-activations"], { stdio: ["pipe", "pipe", "ignore"] });
    const watcher = { events: [], exitedEarly: undefined, stopping: false, stop() { this.stopping = true; child.kill("SIGKILL"); } };
    let buffer = "";
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { watcher.stop(); reject(new Error(`activation watcher did not start within ${timeoutMs} ms`)); }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) { continue; }
                watcher.events.push({ pid: Number(line), at: Date.now() });
                if (watcher.events.length === 1) { clearTimeout(timer); resolve(watcher); }
            }
        });
        child.on("exit", (code, signal) => {
            if (!watcher.stopping) { watcher.exitedEarly = `exit ${code === null ? signal : code}`; }
            if (watcher.events.length === 0) { clearTimeout(timer); reject(new Error(`activation watcher exited before starting (${watcher.exitedEarly})`)); }
        });
    });
}

// SIGKILL the launched instance and wait (up to 5 s) until it and every helper
// still naming its profile are gone, so nothing writes into the profile after
// it is removed. Synchronous so the signal handler can use it too.
function killAndWait(pid, profileDir) {
    if (pid) { killNow(pid); }
    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        let alive = false;
        if (pid) { try { process.kill(pid, 0); alive = true; } catch (_) { /* gone */ } }
        const helpers = childProcess.spawnSync("pgrep", ["-f", profileDir], { encoding: "utf8" }).stdout.trim();
        if (!alive && !helpers) { return; }
        for (const helperPid of helpers.split("\n").filter(Boolean)) { killNow(Number(helperPid)); }
        Atomics.wait(pause, 0, 0, 100);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (process.platform !== "darwin") { throw new Error("Background VS Code checks need macOS with a secondary built-in display."); }
    if (!fs.existsSync(path.join(REPO, "out", "extension.js"))) { throw new Error("Run `npm run bundle` first."); }
    if (typeof WebSocket !== "function") { throw new Error("Node with a global WebSocket (22+) is required."); }
    reapStaleRuns();

    const policy = options.allowVisible ? "none" : "prohibited";
    const [x, y, width, height] = helper("display").split(/\s+/).map(Number);
    const display = { x, y, width, height };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
    fs.writeFileSync(path.join(root, "runner.pid"), String(process.pid));
    const out = options.out || path.join(root, "evidence");
    let pid;
    let keptOpen = false;
    // Default evidence lives inside the temp profile; keep it only after a
    // successful run (the next run removes it).
    let keepDefaultEvidence = false;
    let cdp;
    let watcher;
    const results = [];
    let phase = "launch";

    const cleanup = () => {
        // Always reap by profile, even with no pid yet: an interrupt during the
        // launch helper can leave a started instance whose pid we never saw.
        if (!keptOpen) { killAndWait(pid, path.join(root, "user-data")); }
        if (!keptOpen) {
            const keep = !options.out && keepDefaultEvidence ? out : undefined;
            for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
                if (path.join(root, entry) !== keep) { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); }
            }
            if (!keep) { fs.rmSync(root, { recursive: true, force: true }); }
        }
    };
    const onSignal = (signal) => {
        if (watcher) { watcher.stop(); }
        cleanup();
        console.error(`Interrupted by ${signal}; killed the test instance and removed its profile.`);
        process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] || 1);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) { process.once(signal, onSignal); }

    let failure;
    let stealPids = [];
    try {
        fs.mkdirSync(out, { recursive: true });
        const syncPort = await freePort();
        const cdpPort = await freePort();
        const inspectPort = await freePort();
        const profile = prepareProfile(root, display, syncPort);
        watcher = await watchActivations();

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
            `--inspect-brk=${inspectPort}`,
            profile.workspace));
        console.log(`Launched VS Code pid ${pid} paused (CDP ${cdpPort}, sync port ${syncPort}) into ${root}`);
        phase = "guard";
        await guardMainProcess(inspectPort, policy, pid);
        console.log(`Focus guard applied (activation policy ${policy}); main process resumed.`);

        phase = "window";
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
        if (policy === "prohibited") {
            const actual = helper("policy", String(pid));
            if (actual !== "prohibited") { throw new Error(`activation policy is ${actual}, not prohibited; aborted.`); }
        }
        console.log(`Window ${window.id} placed on the test display at ${window.x},${window.y} ${window.width}x${window.height}${policy === "prohibited" ? " (never shown: prohibited policy)" : ""}`);
        if (options.allowVisible) {
            phase = "unhide";
            console.log(`--allow-visible: unhide: ${helper("unhide", String(pid))}`);
            await sleep(1500);
        }

        phase = "scenario";
        cdp = await Cdp.connect(cdpPort);
        await waitFor("harness", () => harness(profile.ipc, { op: "ping" }, 2000).then((r) => r.extension && r), 60000, 500);
        await harness(profile.ipc, { op: "activate" }, 60000);
        if (options.scenario === "status-bar") {
            await runStatusBarScenario({ cdp, ipc: profile.ipc, out, results });
        } else {
            throw new Error(`Unknown scenario ${options.scenario}`);
        }
        if (policy === "prohibited") {
            const actual = helper("policy", String(pid));
            if (actual !== "prohibited") { throw new Error(`activation policy changed to ${actual} during the run.`); }
        }
    } catch (error) {
        failure = error;
    }

    // Report a focus steal first, even when the scenario failed too: it must
    // never be hidden behind another error and invite a retry.
    if (watcher) { watcher.stop(); }
    const events = watcher ? watcher.events : [];
    stealPids = pid ? events.filter((e) => e.pid === pid) : [];
    try {
        fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({
            display, phase, activationEvents: events.length, frontmostPids: [...new Set(events.map((e) => e.pid))], steals: stealPids.length, results,
        }, null, 2));
    } catch (_) { /* out may not exist */ }
    if (stealPids.length > 0) {
        console.error(`FOCUS STEAL: the test instance (pid ${pid}) was activated ${stealPids.length} time(s) (last phase: ${phase}). Stop and report this; do not retry.`);
    }

    if (cdp) { cdp.close(); }
    if (!failure && options.keepOpen && pid) {
        keptOpen = true;
        console.log(`--keep-open: pid ${pid} keeps running${policy === "prohibited" ? " with no Dock icon or window" : ""}. Stop it with: kill -9 ${pid}; the next run also kills it and removes ${root}`);
    }
    keepDefaultEvidence = !failure && stealPids.length === 0;
    cleanup();

    if (failure) { throw failure; }
    if (stealPids.length > 0) { throw new Error("focus steal detected"); }
    if (!watcher || watcher.exitedEarly || events.length < 1) {
        throw new Error(`activation watcher was not running for the whole run (${watcher ? watcher.exitedEarly || "no events" : "never started"}); focus was not verified.`);
    }
    console.log(`Focus: the test instance was never activated (${events.length - 1} other activation(s) observed after the initial frontmost sample).`);
    console.log(`Evidence: ${out}${options.out ? "" : " (temporary; removed by the next run)"}`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
