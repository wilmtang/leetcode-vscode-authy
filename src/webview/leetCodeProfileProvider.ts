// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as crypto from "crypto";
import { commands, ViewColumn } from "vscode";
import { AUTH_SYNC_CAPTION, IAuthSyncSummary } from "../auth/authSyncSummary";
import {
    ILeetCodeBeats,
    ILeetCodeDifficultyCount,
    ILeetCodeLanguageCount,
    ILeetCodeRecentSubmission,
    IProfileIdentity,
    IProfileLanguages,
    IProfileRecent,
    IProfileStats,
} from "../request/leetcode-api";
import { getUrl } from "../shared";
import { ILeetCodeWebviewOption, LeetCodeWebview } from "./LeetCodeWebview";

// One slot per dynamically-filled section. The webview holds a `#sec-<id>`
// container for each; the extension posts `{ command: "section", id, html }`
// and the client swaps that container's innerHTML in place.
export type ProfileSectionId = "header" | "about" | "totals" | "languages" | "recent" | "sync";

// Local cookie/auth-sync state surfaced in the panel's "Session Sync" card. The
// shared IAuthSyncSummary (label/tone/timestamps) is gathered by the command and
// joined with the signed-in account fields, so this provider stays a pure
// renderer and the wording matches the status-bar tooltip.
export interface IProfileSyncStatus extends IAuthSyncSummary {
    username: string;
    isPremium: boolean;
    isVerified: boolean;
}

// What the panel can paint the instant it opens — no network required. The
// username/avatar come from the cached user status so the header is never blank.
export interface IProfileInitial {
    username: string;
    avatar: string;
    syncStatus: IProfileSyncStatus;
}

interface ISectionMessage {
    command: "section";
    id: ProfileSectionId;
    state: "ok" | "error";
    html: string;
}

// Panel that opens when the user clicks the LeetCode status bar item. Mirrors
// the public leetcode.com/u/<user>/ + /progress/ pages: total solved, per-
// difficulty progress bars + beats percentages, language breakdown, recent
// accepted submissions, identity (ranking, country, company, school), plus a
// cookie-sync status card.
//
// Rendering is progressive: open() paints a shell (header + sync card from local
// state, skeletons for everything that needs the network) and reveals the panel
// immediately. The command then fires the four profile queries independently and
// calls updateXxx()/failSection() as each lands; each call posts a message that
// fills (or errors) exactly one section. A ready handshake guards the gap between
// setting the HTML and the webview's script wiring up its message listener:
// updates that arrive early are queued and flushed on "ready".
class LeetCodeProfileProvider extends LeetCodeWebview {
    protected readonly viewType: string = "leetcode.profile";
    private initial?: IProfileInitial;
    private username: string = "";
    private ready: boolean = false;
    private pending: ISectionMessage[] = [];

    public open(initial: IProfileInitial): void {
        this.initial = initial;
        this.username = initial.username;
        this.ready = false;
        this.pending = [];
        this.showWebviewInternal();
    }

    public updateIdentity(identity: IProfileIdentity): void {
        this.username = identity.username || this.username;
        if (this.panel) {
            this.panel.title = this.username ? `LeetCode: ${this.username}` : "LeetCode Profile";
        }
        this.postSection("header", "ok", buildHeaderInner(identity, false));
        this.postSection("about", "ok", buildIdentityRows(identity) || emptyNote("No public profile details."));
    }

    public updateStats(stats: IProfileStats): void {
        this.postSection("totals", "ok", buildTotalsInner(stats));
    }

    public updateRecent(recent: IProfileRecent): void {
        this.postSection("recent", "ok", buildRecentRows(recent.recentAcSubmissions, getUrl("base")) || emptyNote("No recent AC submissions."));
    }

    public updateLanguages(languages: IProfileLanguages): void {
        this.postSection("languages", "ok", buildLanguageRows(languages.languageProblemCount) || emptyNote("No language stats yet."));
    }

    // Re-render the Session Sync card in place. Called on every auth sync while
    // the panel is open, so "Last auth sync" resets to "just now" without a
    // manual Refresh; no-ops when the panel is closed (see postSection guard).
    public updateSync(sync: IProfileSyncStatus): void {
        this.postSection("sync", "ok", buildSyncCard(sync));
    }

    public failSection(id: ProfileSectionId, message: string): void {
        this.postSection(id, "error", errorNote(message));
    }

    protected getWebviewOption(): ILeetCodeWebviewOption {
        const title: string = this.username ? `LeetCode: ${this.username}` : "LeetCode Profile";
        return { title, viewColumn: ViewColumn.One };
    }

    // The base class rebuilds the entire webview HTML on any `markdown.*` config
    // change. For the static preview/solution panels that's fine, but this panel
    // renders progressively — open() paints skeletons and each section is filled
    // later via postMessage — so a rebuild would revert every loaded section to a
    // skeleton with no re-fetch. This panel uses none of the markdown styling, so
    // suppress the rebuild entirely. (A2-7.)
    protected async onDidChangeConfiguration(): Promise<void> {
        // Intentionally a no-op; see comment above.
    }

    protected getWebviewContent(): string {
        if (!this.initial) {
            return this.emptyContent();
        }

        const nonce: string = crypto.randomBytes(16).toString("base64");
        const initial: IProfileInitial = this.initial;
        const headerInner: string = buildHeaderInner(
            { username: initial.username, avatar: initial.avatar, ranking: undefined, realName: "", countryName: "", company: "", school: "", reputation: 0 },
            true,
        );
        const syncInner: string = buildSyncCard(initial.syncStatus);

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
                <style>
                    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.5rem; }
                    h1, h2 { margin-bottom: 0.5rem; }
                    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
                    a:hover { text-decoration: underline; }
                    .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
                    .header-main { display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 0; }
                    .avatar { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: var(--vscode-editorWidget-background); }
                    .avatar-placeholder { display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1.25rem; }
                    .meta { line-height: 1.4; min-width: 0; }
                    .meta .name { font-size: 1.25rem; font-weight: 600; }
                    .meta .secondary { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
                    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem; }
                    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; padding: 1rem; }
                    .card h2 { margin-top: 0; font-size: 1rem; display: flex; align-items: center; gap: 0.4rem; }
                    .card.has-error { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
                    .full { grid-column: 1 / -1; }
                    .totals { text-align: center; padding: 1.25rem 1rem; }
                    .totals .big { font-size: 2.5rem; font-weight: 700; }
                    .totals .denom { color: var(--vscode-descriptionForeground); font-size: 1rem; }
                    .difficulty-row { display: grid; grid-template-columns: 70px 1fr 110px; align-items: center; gap: 0.75rem; margin: 0.5rem 0; }
                    .difficulty-row .label { font-weight: 600; }
                    .difficulty-row.easy .label { color: #00b8a3; }
                    .difficulty-row.medium .label { color: #ffb700; }
                    .difficulty-row.hard .label { color: #ff375f; }
                    .bar { background: var(--vscode-progressBar-background, rgba(127,127,127,0.2)); height: 8px; border-radius: 4px; overflow: hidden; }
                    .bar .fill { height: 100%; }
                    .easy .fill { background: #00b8a3; }
                    .medium .fill { background: #ffb700; }
                    .hard .fill { background: #ff375f; }
                    .difficulty-row .stats { text-align: right; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
                    .difficulty-row .stats .solved { color: var(--vscode-foreground); }
                    .beats { display: flex; gap: 1rem; margin-top: 0.75rem; flex-wrap: wrap; justify-content: center; }
                    .beats .pill { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 12px; padding: 0.15rem 0.65rem; font-size: 0.8rem; }
                    table { width: 100%; border-collapse: collapse; }
                    table th, table td { text-align: left; padding: 0.35rem 0.5rem; font-size: 0.9rem; }
                    table tr + tr td { border-top: 1px solid var(--vscode-editorWidget-border); }
                    table td.num { text-align: right; font-variant-numeric: tabular-nums; }
                    .identity { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 0.75rem; font-size: 0.9rem; align-items: baseline; }
                    .identity dt { color: var(--vscode-descriptionForeground); white-space: nowrap; }
                    .identity dd { margin: 0; }
                    .sync-status { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; margin-bottom: 0.25rem; }
                    .sync-caption { color: var(--vscode-descriptionForeground); font-size: 0.82rem; margin-bottom: 0.85rem; }
                    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
                    .dot.ok { background: #3fb950; }
                    .dot.warn { background: #d29922; }
                    .dot.bad { background: #f85149; }
                    .badge { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 0.05rem 0.5rem; font-size: 0.72rem; margin-left: 0.35rem; vertical-align: middle; }
                    .conflict { margin-top: 0.85rem; padding: 0.5rem 0.65rem; border-radius: 4px; font-size: 0.85rem; background: var(--vscode-inputValidation-warningBackground, rgba(210,153,34,0.12)); border: 1px solid var(--vscode-inputValidation-warningBorder, #d29922); }
                    .actions { display: flex; gap: 0.75rem; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.35rem 0.85rem; cursor: pointer; border-radius: 2px; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
                    .empty.error { color: var(--vscode-errorForeground); font-style: normal; }
                    .skeleton-line { height: 0.8rem; border-radius: 4px; background: var(--vscode-editorWidget-border); margin: 0.55rem 0; animation: pulse 1.3s ease-in-out infinite; }
                    .skeleton-line.short { width: 40%; }
                    .skeleton-line.wide { width: 85%; }
                    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.65; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="header-main" id="sec-header">${headerInner}</div>
                    <div class="actions">
                        <button id="refresh">Refresh</button>
                        <button id="open-leetcode">Open on LeetCode</button>
                    </div>
                </div>

                <div class="card full" id="card-sync">
                    <h2>Session Sync</h2>
                    <div id="sec-sync">${syncInner}</div>
                </div>

                <div class="grid">
                    <div class="card totals loading" id="card-totals">
                        <div id="sec-totals">${skeleton(4)}</div>
                    </div>

                    <div class="card loading" id="card-about">
                        <h2>About</h2>
                        <div id="sec-about">${skeleton(4)}</div>
                    </div>

                    <div class="card loading" id="card-languages">
                        <h2>Languages</h2>
                        <div id="sec-languages">${skeleton(3)}</div>
                    </div>

                    <div class="card loading" id="card-recent">
                        <h2>Recent Accepted</h2>
                        <div id="sec-recent">${skeleton(3)}</div>
                    </div>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();

                    function fmtAgo(diffMs) {
                        if (!isFinite(diffMs) || diffMs < 0) { diffMs = 0; }
                        const s = Math.floor(diffMs / 1000);
                        if (s < 45) { return "just now"; }
                        if (s < 90) { return "1m ago"; }
                        const m = Math.floor(s / 60);
                        if (m < 60) { return m + "m ago"; }
                        const h = Math.floor(s / 3600);
                        if (h < 24) { return h + "h ago"; }
                        const d = Math.floor(s / 86400);
                        return d + "d ago";
                    }

                    function tick() {
                        const now = Date.now();
                        const nodes = document.querySelectorAll("[data-relative-ms]");
                        for (let i = 0; i < nodes.length; i++) {
                            const t = Number(nodes[i].getAttribute("data-relative-ms"));
                            if (isFinite(t) && t > 0) { nodes[i].textContent = fmtAgo(now - t); }
                        }
                    }

                    window.addEventListener("message", function (event) {
                        const m = event.data || {};
                        if (m.command !== "section") { return; }
                        const el = document.getElementById("sec-" + m.id);
                        if (!el) { return; }
                        el.innerHTML = m.html;
                        const card = el.closest(".card");
                        if (card) {
                            card.classList.remove("loading");
                            card.classList.toggle("has-error", m.state === "error");
                        }
                        tick();
                    });

                    const refresh = document.getElementById("refresh");
                    if (refresh) { refresh.onclick = function () { vscode.postMessage({ command: "Refresh" }); }; }
                    const open = document.getElementById("open-leetcode");
                    if (open) { open.onclick = function () { vscode.postMessage({ command: "OpenProfile" }); }; }

                    tick();
                    setInterval(tick, 30000);
                    vscode.postMessage({ command: "ready" });
                </script>
            </body>
            </html>
        `;
    }

    protected async onDidReceiveMessage(message: { command?: string }): Promise<void> {
        switch (message.command) {
            case "ready":
                this.ready = true;
                for (const queued of this.pending) {
                    this.deliver(queued);
                }
                this.pending = [];
                break;
            case "Refresh":
                await commands.executeCommand("leetcode.showUserProfile");
                break;
            case "OpenProfile":
                if (this.username) {
                    const url: string = `${getUrl("base")}/u/${encodeURIComponent(this.username)}/`;
                    await commands.executeCommand("vscode.open", url);
                }
                break;
            default:
                break;
        }
    }

    private postSection(id: ProfileSectionId, state: "ok" | "error", html: string): void {
        if (!this.panel) {
            return;
        }
        const message: ISectionMessage = { command: "section", id, state, html };
        if (this.ready) {
            this.deliver(message);
        } else {
            // Drop any earlier queued update for the same section so a refresh
            // never flushes a stale value ahead of the latest one.
            this.pending = this.pending.filter((entry: ISectionMessage) => entry.id !== id);
            this.pending.push(message);
        }
    }

    private deliver(message: ISectionMessage): void {
        if (this.panel) {
            void this.panel.webview.postMessage(message);
        }
    }

    private emptyContent(): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none';" />
                <style>body { font-family: var(--vscode-font-family); padding: 1.5rem; }</style>
            </head>
            <body><p>Sign in to LeetCode to see your profile.</p></body>
            </html>
        `;
    }
}

function buildHeaderInner(identity: IProfileIdentity, loading: boolean): string {
    const base: string = getUrl("base");
    const profileUrl: string = `${base}/u/${encodeURIComponent(identity.username)}/`;
    const avatarBlock: string = identity.avatar
        ? `<img class="avatar" src="${escapeAttribute(identity.avatar)}" alt="avatar" />`
        : `<div class="avatar avatar-placeholder">${escapeHtml(initials(identity.username))}</div>`;
    const realName: string = identity.realName ? ` <span class="secondary">(${escapeHtml(identity.realName)})</span>` : "";
    const secondary: string = loading ? "Loading profile…" : formatRanking(identity.ranking);
    return `
        ${avatarBlock}
        <div class="meta">
            <div class="name"><a href="${escapeAttribute(profileUrl)}">${escapeHtml(identity.username)}</a>${realName}</div>
            <div class="secondary">${escapeHtml(secondary)}</div>
        </div>
    `;
}

function buildTotalsInner(stats: IProfileStats): string {
    const all: ILeetCodeDifficultyCount = pickDifficulty(stats.solvedByDifficulty, "All") || { difficulty: "All", count: 0 };
    const allTotal: ILeetCodeDifficultyCount = pickDifficulty(stats.totalsByDifficulty, "All") || { difficulty: "All", count: 0 };
    const easy: ILeetCodeDifficultyCount = pickDifficulty(stats.solvedByDifficulty, "Easy") || { difficulty: "Easy", count: 0 };
    const medium: ILeetCodeDifficultyCount = pickDifficulty(stats.solvedByDifficulty, "Medium") || { difficulty: "Medium", count: 0 };
    const hard: ILeetCodeDifficultyCount = pickDifficulty(stats.solvedByDifficulty, "Hard") || { difficulty: "Hard", count: 0 };
    const easyTotal: number = (pickDifficulty(stats.totalsByDifficulty, "Easy") || { count: 0 }).count;
    const mediumTotal: number = (pickDifficulty(stats.totalsByDifficulty, "Medium") || { count: 0 }).count;
    const hardTotal: number = (pickDifficulty(stats.totalsByDifficulty, "Hard") || { count: 0 }).count;
    const beats: { [key: string]: number | undefined } = beatsMap(stats.beatsByDifficulty);

    return `
        <div class="big">${all.count}</div>
        <div class="denom">Solved / ${allTotal.count || "?"}</div>
        <div class="difficulty-row easy">
            <span class="label">Easy</span>
            <div class="bar"><div class="fill" style="width:${percent(easy.count, easyTotal)}%"></div></div>
            <span class="stats"><span class="solved">${easy.count}</span> / ${easyTotal || "?"}</span>
        </div>
        <div class="difficulty-row medium">
            <span class="label">Medium</span>
            <div class="bar"><div class="fill" style="width:${percent(medium.count, mediumTotal)}%"></div></div>
            <span class="stats"><span class="solved">${medium.count}</span> / ${mediumTotal || "?"}</span>
        </div>
        <div class="difficulty-row hard">
            <span class="label">Hard</span>
            <div class="bar"><div class="fill" style="width:${percent(hard.count, hardTotal)}%"></div></div>
            <span class="stats"><span class="solved">${hard.count}</span> / ${hardTotal || "?"}</span>
        </div>
        <div class="beats">
            ${renderBeatsPill("Easy", beats["Easy"])}
            ${renderBeatsPill("Medium", beats["Medium"])}
            ${renderBeatsPill("Hard", beats["Hard"])}
        </div>
    `;
}

function buildSyncCard(sync: IProfileSyncStatus): string {
    const rows: string[] = [];

    rows.push(`<dt>Last auth sync</dt><dd>${relativeTimestamp(sync.lastSyncedAt)}</dd>`);

    const account: string[] = [escapeHtml(sync.username || "Unknown")];
    if (sync.isPremium) {
        account.push(`<span class="badge">Premium</span>`);
    }
    if (sync.isVerified) {
        account.push(`<span class="badge">Verified</span>`);
    }
    rows.push(`<dt>Account</dt><dd>${account.join(" ")}</dd>`);

    rows.push(`<dt>This window</dt><dd>${escapeHtml(sync.currentWindowLabel || "this window")}</dd>`);

    if (!sync.ownedByThisWindow && sync.ownerWindowLabel) {
        rows.push(`<dt>Sync owner</dt><dd>${escapeHtml(sync.ownerWindowLabel)}</dd>`);
    }

    if (typeof sync.port === "number") {
        rows.push(`<dt>Port</dt><dd>${sync.port}</dd>`);
    }

    if (typeof sync.ownerHeartbeatAt === "number") {
        rows.push(`<dt>Last heartbeat</dt><dd>${relativeTimestamp(sync.ownerHeartbeatAt)}</dd>`);
    }

    const conflict: string = sync.hasConflict && sync.conflictSummary
        ? `<div class="conflict">${escapeHtml(sync.conflictSummary)}</div>`
        : "";

    return `
        <div class="sync-status"><span class="dot ${escapeAttribute(sync.tone)}"></span>${escapeHtml(sync.label)}</div>
        <div class="sync-caption">${escapeHtml(AUTH_SYNC_CAPTION)}</div>
        <dl class="identity">${rows.join("")}</dl>
        ${conflict}
    `;
}

// Renders a Unix-ms timestamp as a live-updating "x ago" span (the webview's
// ticker rewrites [data-relative-ms] every 30s) with the absolute time on hover.
function relativeTimestamp(timestampMs: number | undefined): string {
    if (typeof timestampMs !== "number" || !(timestampMs > 0)) {
        return `<span class="empty">Never</span>`;
    }
    const absolute: string = new Date(timestampMs).toLocaleString();
    return `<span data-relative-ms="${timestampMs}" title="${escapeAttribute(absolute)}">${escapeHtml(absolute)}</span>`;
}

function skeleton(lines: number): string {
    const widths: string[] = ["wide", "", "short", "wide", "short"];
    let out: string = "";
    for (let i = 0; i < lines; i++) {
        out += `<div class="skeleton-line ${widths[i % widths.length]}"></div>`;
    }
    return out;
}

function emptyNote(message: string): string {
    return `<div class="empty">${escapeHtml(message)}</div>`;
}

function errorNote(message: string): string {
    return `<div class="empty error">${escapeHtml(message)}</div>`;
}

function pickDifficulty(entries: ILeetCodeDifficultyCount[], difficulty: ILeetCodeDifficultyCount["difficulty"]): ILeetCodeDifficultyCount | undefined {
    for (const entry of entries) {
        if (entry.difficulty === difficulty) {
            return entry;
        }
    }
    return undefined;
}

function percent(numerator: number, denominator: number): number {
    if (!denominator || denominator <= 0) {
        return 0;
    }
    const value: number = (numerator * 100) / denominator;
    return Math.max(0, Math.min(100, value));
}

function beatsMap(beats: ILeetCodeBeats[]): { [key: string]: number | undefined } {
    const out: { [key: string]: number | undefined } = {};
    for (const entry of beats) {
        out[entry.difficulty] = entry.percentage;
    }
    return out;
}

function renderBeatsPill(label: string, percentage: number | undefined): string {
    if (typeof percentage !== "number") {
        return "";
    }
    const top: string = (100 - percentage).toFixed(1);
    const tooltip: string = `Percentile rank by problems solved: you have solved more ${label} problems than ${percentage.toFixed(1)}% of LeetCode users, placing you in the top ${top}%. Reflects how many ${label} problems you have solved, not your solution's speed or memory.`;
    return `<span class="pill" title="${escapeAttribute(tooltip)}">${escapeHtml(label)}: top ${top}%</span>`;
}

function formatRanking(ranking: number | undefined): string {
    if (!ranking) {
        return "Unranked";
    }
    return `Global ranking: #${ranking.toLocaleString()}`;
}

function buildIdentityRows(identity: IProfileIdentity): string {
    const rows: string[] = [];
    if (identity.countryName) {
        rows.push(`<dt>Country</dt><dd>${escapeHtml(identity.countryName)}</dd>`);
    }
    if (identity.company) {
        rows.push(`<dt>Company</dt><dd>${escapeHtml(identity.company)}</dd>`);
    }
    if (identity.school) {
        rows.push(`<dt>School</dt><dd>${escapeHtml(identity.school)}</dd>`);
    }
    if (typeof identity.ranking === "number" && identity.ranking > 0) {
        rows.push(`<dt>Ranking</dt><dd>#${identity.ranking.toLocaleString()}</dd>`);
    }
    if (identity.reputation) {
        rows.push(`<dt>Reputation</dt><dd>${identity.reputation.toLocaleString()}</dd>`);
    }
    return rows.length > 0 ? `<dl class="identity">${rows.join("")}</dl>` : "";
}

function buildRecentRows(submissions: ILeetCodeRecentSubmission[], base: string): string {
    if (submissions.length === 0) {
        return "";
    }

    const rows: string = submissions
        .slice(0, 10)
        .map((entry: ILeetCodeRecentSubmission) => {
            const url: string = `${base}/problems/${encodeURIComponent(entry.titleSlug)}/`;
            return `<tr><td><a href="${escapeAttribute(url)}">${escapeHtml(entry.title)}</a></td><td class="num">${escapeHtml(formatRelativeTimestamp(entry.timestamp))}</td></tr>`;
        })
        .join("");
    return `<table>${rows}</table>`;
}

function buildLanguageRows(languages: ILeetCodeLanguageCount[]): string {
    if (languages.length === 0) {
        return "";
    }

    const rows: string = languages
        .slice(0, 8)
        .map((entry: ILeetCodeLanguageCount) =>
            `<tr><td>${escapeHtml(entry.languageName)}</td><td class="num">${entry.problemsSolved}</td></tr>`,
        )
        .join("");
    return `<table>${rows}</table>`;
}

function formatRelativeTimestamp(timestampSeconds: number): string {
    if (!timestampSeconds) {
        return "";
    }
    // Avoid `Date.now()` so this stays renderable in pure unit tests, but the
    // webview only runs in vscode so a normal now() is fine.
    const nowSeconds: number = Math.floor(Date.now() / 1000);
    const diff: number = nowSeconds - timestampSeconds;
    if (diff < 0) {
        return new Date(timestampSeconds * 1000).toLocaleDateString();
    }
    if (diff < 60) {
        return `${diff}s ago`;
    }
    if (diff < 3600) {
        return `${Math.floor(diff / 60)}m ago`;
    }
    if (diff < 86400) {
        return `${Math.floor(diff / 3600)}h ago`;
    }
    if (diff < 30 * 86400) {
        return `${Math.floor(diff / 86400)}d ago`;
    }
    return new Date(timestampSeconds * 1000).toLocaleDateString();
}

function initials(username: string): string {
    const trimmed: string = (username || "").trim();
    if (!trimmed) {
        return "?";
    }
    return trimmed.slice(0, 2).toUpperCase();
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch: string) => {
        switch (ch) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "\"": return "&quot;";
            case "'": return "&#39;";
            default: return ch;
        }
    });
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}

export const leetCodeProfileProvider: LeetCodeProfileProvider = new LeetCodeProfileProvider();
