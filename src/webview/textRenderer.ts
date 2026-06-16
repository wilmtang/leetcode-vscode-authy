// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { KatexOptions, renderToString } from "katex";

// Shared rendering primitives for the problem description (HTML) and the
// community solutions (markdown). Adapted from better-leetcode's textRenderer:
// pull LaTeX math ($…$ / $$…$$ / \(…\) / \[…\]) into placeholders → render it
// with KaTeX (literal fallback on failure) → XSS-sanitize the surrounding markup
// (scripts/handlers stripped, iframes whitelisted to LeetCode) → splice the
// rendered math back. The description is already HTML, so it skips markdown; the
// solution provider runs markdown-it between extract and sanitize.

// Alphanumeric so it survives markdown-it untouched (a leading-space token would
// get trimmed when it starts a line).
const PLACEHOLDER_RE: RegExp = /LCMATHPLACEHOLDER(\d+)ENDLCMATH/g;
const LEETCODE_IFRAME_HOSTS: RegExp = /^(https?:)?\/\/([a-z0-9-]+\.)*(leetcode\.com|leetcode\.cn)\//i;

export interface IMathExtraction {
    text: string;
    math: string[];
}

// Renders LeetCode's HTML problem description for the preview webview.
export function renderDescriptionHtml(html: string): string {
    const extracted: IMathExtraction = extractMathPlaceholders(html || "");
    const sanitized: string = sanitizeHtml(extracted.text);
    const wrapped: string = wrapPreBlocks(sanitized);
    return restoreMath(wrapped, extracted.math);
}

export function extractMathPlaceholders(input: string): IMathExtraction {
    const math: string[] = [];
    let text: string = input;
    text = replaceMath(text, /\$\$([\s\S]+?)\$\$/g, true, math);
    text = replaceMath(text, /\\\[([\s\S]+?)\\\]/g, true, math);
    text = replaceMath(text, /\\\(([\s\S]+?)\\\)/g, false, math);
    // Inline $…$ last. Currency guard: the opening `$` must not be followed by
    // whitespace and the closing `$` must not be followed by a digit, so paired
    // amounts like "you have $5 and $3" are left as plain text.
    text = replaceMath(text, /\$(?!\$)(?!\s)([^$\n]+?)\$(?!\d)/g, false, math);
    return { text, math };
}

export function restoreMath(input: string, math: string[]): string {
    return input.replace(PLACEHOLDER_RE, (match: string, indexText: string): string => {
        const index: number = parseInt(indexText, 10);
        return Number.isFinite(index) && math[index] !== undefined ? math[index] : match;
    });
}

// Defense-in-depth alongside the webview CSP: remove the obvious script-injection
// vectors from the untrusted description/solution markup.
export function sanitizeHtml(input: string): string {
    let output: string = input;
    output = output.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    output = output.replace(/<script\b[^>]*>/gi, "");
    output = output.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
    // Strip inline event handlers (on*=...) and javascript: URLs.
    output = output.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    output = output.replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "$1=\"#\"");
    // Only keep iframes pointing at LeetCode (embedded explainers); drop the rest.
    output = output.replace(/<iframe\b[^>]*>(?:[\s\S]*?<\/iframe\s*>)?/gi, (tag: string): string => {
        const srcMatch: RegExpMatchArray | null = tag.match(/\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i);
        const src: string = srcMatch ? (srcMatch[1] || srcMatch[2] || "") : "";
        return LEETCODE_IFRAME_HOSTS.test(src) ? tag : "";
    });
    return output;
}

function replaceMath(input: string, pattern: RegExp, displayMode: boolean, store: string[]): string {
    return input.replace(pattern, (_match: string, tex: string): string => {
        const index: number = store.length;
        store.push(renderMath(tex, displayMode));
        return `LCMATHPLACEHOLDER${index}ENDLCMATH`;
    });
}

function renderMath(tex: string, displayMode: boolean): string {
    const options: KatexOptions = { displayMode, throwOnError: false, strict: "ignore", output: "htmlAndMathml" };
    try {
        return renderToString(tex, options);
    } catch (error) {
        // throwOnError:false already renders parse errors inline, but guard the
        // rare hard failure so a single bad expression cannot blank the preview.
        return `<code>${escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`)}</code>`;
    }
}

function wrapPreBlocks(input: string): string {
    // Preserve the existing behaviour: ensure <pre> blocks carry a <code> child
    // so the webview's stylesheet renders them as code.
    return input.replace(/<pre>[\r\n]*([\s\S]+?)[\r\n]*<\/pre>/g, "<pre><code>$1</code></pre>");
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
