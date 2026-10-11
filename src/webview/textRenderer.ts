// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { KatexOptions, renderToString } from "katex";
import sanitizeHtmlLibrary = require("sanitize-html");

// Shared rendering primitives for the problem description (HTML) and the
// community solutions (markdown). Adapted from better-leetcode's textRenderer:
// pull LaTeX math ($…$ / $$…$$ / \(…\) / \[…\]) into placeholders → render it
// with KaTeX (literal fallback on failure) → XSS-sanitize the surrounding markup
// with a strict allow-list → splice the rendered math back at sanitized marker
// elements. The description is already HTML, so it skips markdown; the solution
// provider runs markdown-it between extract and sanitize.

// A real marker element keeps restoration in HTML element/text context. A plain
// token could also survive inside an href/src attribute, where replacing it
// with KaTeX markup after sanitization would create malformed HTML.
const PLACEHOLDER_RE: RegExp = /<span data-lc-math-placeholder="(\d+)"><\/span>/g;
const HTML_TAG_SPLIT_RE: RegExp = /(<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->)/g;
const ALLOWED_TAGS: string[] = [
    "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div",
    "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd",
    "li", "mark", "ol", "p", "pre", "s", "small", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "u", "ul",
];

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

// Call only after sanitization and trusted KaTeX restoration. Remote markup
// cannot supply either style attributes or this private selector attribute.
export function collectMathStyles(input: string): { html: string; css: string } {
    const rules: string[] = [];
    const html = input.replace(/ style="([^"]*)"/g, (_match, declarations: string) => {
        const index = rules.length;
        // KaTeX emits numeric layout declarations and parsed colors. Never let
        // markup delimiters or escaped CSS enter a style element.
        if (!/^[a-z0-9\s:;.,()%+#-]*$/i.test(declarations)) {
            return "";
        }
        rules.push(`[data-lc-math-style="${index}"]{${declarations}}`);
        return ` data-lc-math-style="${index}"`;
    });
    return { html, css: rules.join("\n") };
}

export function stripMarkdownHtmlComments(input: string): string {
    return input
        .split(/\r?\n/)
        .filter((line: string) => !/^\s*<!--[\s\S]*-->\s*$/.test(line))
        .join("\n");
}

// Parse and allow-list untrusted description/solution markup. A regex-only
// sanitizer misses browser-normalized forms such as unquoted attributes and
// entity-encoded schemes, so use a real HTML parser and fail closed on tags,
// attributes, and URL schemes.
export function sanitizeHtml(input: string): string {
    return sanitizeHtmlLibrary(input, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
            a: ["href", "name", "rel", "title"],
            code: ["class"],
            details: ["open"],
            div: ["class"],
            img: ["alt", "height", "src", "title", "width"],
            pre: ["class"],
            span: ["class", "data-lc-math-placeholder"],
            table: ["class"],
            td: ["colspan", "rowspan"],
            th: ["colspan", "rowspan", "scope"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        allowedSchemesByTag: {
            img: ["data", "http", "https"],
        },
        allowProtocolRelative: true,
        transformTags: {
            a: (_tagName: string, attribs: { [key: string]: string }) => ({
                tagName: "a",
                attribs: {
                    ...attribs,
                    rel: "noopener noreferrer",
                },
            }),
        },
    });
}

function replaceMath(input: string, pattern: RegExp, displayMode: boolean, store: string[]): string {
    return input
        .split(HTML_TAG_SPLIT_RE)
        .map((part: string): string => {
            if (/^<\/?[A-Za-z]|^<!--/.test(part)) {
                return part;
            }
            return part.replace(pattern, (_match: string, tex: string): string => {
                const index: number = store.length;
                store.push(renderMath(tex, displayMode));
                return `<span data-lc-math-placeholder="${index}"></span>`;
            });
        })
        .join("");
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
