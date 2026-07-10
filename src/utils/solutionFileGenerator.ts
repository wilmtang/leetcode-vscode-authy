// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ILeetCodeCodeSnippet, ILeetCodeQuestionDetail } from "../request/leetcode-api";
import { getCommentStyle, ICommentStyle } from "./codeTemplateUtils";
import { decodeHtmlEntities } from "./htmlText";

const DESC_WRAP_WIDTH: number = 79;

export interface IGenerateSolutionFileOptions {
    detail: ILeetCodeQuestionDetail;
    language: string;
    // The user-facing frontend id (e.g. "1"). Kept distinct from the API's
    // internal questionId so the @lc header matches what the CLI used to write.
    frontendId: string;
    showDescriptionInComment: boolean;
    // Canonical problem URL base, e.g. "https://leetcode.com" or "https://leetcode.cn".
    endpointBase: string;
}

interface IQuestionStats {
    acRate?: string;
    totalAccepted?: string;
    totalSubmission?: string;
}

// Builds the solution file the extension now writes itself, replacing the
// `leetcode show -c/-cx` CLI call. The header always embeds the canonical
// problem URL so the already-migrated submit/test parseSlug() recovers the slug
// regardless of the (possibly customised) filename — the Phase 4 slug hardening.
export function generateSolutionFileContent(options: IGenerateSolutionFileOptions): string {
    const { detail, language, frontendId, showDescriptionInComment, endpointBase } = options;
    const comment: ICommentStyle = getCommentStyle(language);
    const link: string = `${endpointBase}/problems/${detail.titleSlug}/`;
    const code: string = pickSnippet(detail.codeSnippets, language);

    const header: string[] = [comment.start];
    header.push(`${comment.line} @lc app=leetcode id=${frontendId} lang=${language}`);
    header.push(comment.line);
    header.push(`${comment.line} [${frontendId}] ${detail.title}`);
    header.push(comment.line);
    header.push(`${comment.line} ${link}`);

    if (showDescriptionInComment) {
        header.push(...buildDescriptionComment(detail, comment));
    }

    header.push(comment.end);

    const body: string[] = [
        "",
        `${comment.singleLine} @lc code=start`,
        code,
        `${comment.singleLine} @lc code=end`,
        "",
    ];

    return header.concat(body).join("\n");
}

function pickSnippet(snippets: ILeetCodeCodeSnippet[], language: string): string {
    const match: ILeetCodeCodeSnippet | undefined = snippets.find((snippet: ILeetCodeCodeSnippet) => snippet.langSlug === language);
    if (!match) {
        return "";
    }

    return match.code.replace(/\r\n/g, "\n");
}

function buildDescriptionComment(detail: ILeetCodeQuestionDetail, comment: ICommentStyle): string[] {
    const stats: IQuestionStats = parseStats(detail.stats);
    const lines: string[] = [comment.line];

    if (detail.categoryTitle) {
        lines.push(`${comment.line} ${detail.categoryTitle}`);
    }
    lines.push(`${comment.line} ${detail.difficulty}${stats.acRate ? ` (${stats.acRate})` : ""}`);
    lines.push(`${comment.line} Likes:    ${detail.likes}`);
    lines.push(`${comment.line} Dislikes: ${detail.dislikes}`);
    if (stats.totalAccepted) {
        lines.push(`${comment.line} Total Accepted:    ${stats.totalAccepted}`);
    }
    if (stats.totalSubmission) {
        lines.push(`${comment.line} Total Submissions: ${stats.totalSubmission}`);
    }
    const sampleTestCase: string = detail.sampleTestCase || (detail.exampleTestcaseList || [])[0] || "";
    if (sampleTestCase) {
        lines.push(`${comment.line} Testcase Example:  ${JSON.stringify(sampleTestCase)}`);
    }

    lines.push(comment.line);
    const descLines: string[] = htmlToCommentLines(detail.content, DESC_WRAP_WIDTH - comment.line.length);
    for (const descLine of descLines) {
        lines.push(descLine ? `${comment.line} ${descLine}` : comment.line);
    }

    return lines;
}

function parseStats(stats: string | undefined): IQuestionStats {
    if (!stats) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(stats);
        if (parsed && typeof parsed === "object") {
            return parsed as IQuestionStats;
        }
    } catch (error) {
        // stats is best-effort metadata; ignore malformed payloads.
    }

    return {};
}

// Converts LeetCode's HTML description into wrapped plain-text lines for the
// "description in comment" mode. Deliberately lightweight (no cheerio/he): strip
// tags, decode entities, and word-wrap — mirroring the CLI's output closely
// enough that the comment block reads the same.
export function htmlToCommentLines(html: string, width: number): string[] {
    const text: string = htmlToPlainText(html);
    const wrapWidth: number = width > 16 ? width : 16;
    const wrapped: string[] = [];
    for (const rawLine of text.split("\n")) {
        if (!rawLine) {
            wrapped.push("");
            continue;
        }
        wrapped.push(...wordWrap(rawLine, wrapWidth));
    }

    return collapseBlankRuns(wrapped);
}

export function htmlToPlainText(html: string): string {
    let text: string = html || "";
    // <sup>x</sup> -> ^x (power operator), matching the CLI.
    text = text.replace(/<sup>/gi, "^").replace(/<\/sup>/gi, "");
    // Block-level boundaries become line breaks.
    text = text.replace(/<\/(p|div|li|tr|h[1-6]|pre|ul|ol|table|blockquote)>/gi, "\n");
    text = text.replace(/<br\s*\/?>(?:\s*)/gi, "\n");
    // Drop everything else that looks like a tag.
    text = text.replace(/<[^>]+>/g, "");
    text = decodeHtmlEntities(text);
    // Normalise whitespace: trim trailing spaces, collapse 3+ blank lines.
    text = text.replace(/\r\n|\r/g, "\n").replace(/[ \t]+\n/g, "\n");
    return text.trim();
}

function wordWrap(line: string, width: number): string[] {
    const words: string[] = line.split(/\s+/).filter((word: string) => word.length > 0);
    if (words.length === 0) {
        return [""];
    }

    const out: string[] = [];
    let current: string = "";
    for (const word of words) {
        if (!current) {
            current = word;
        } else if (current.length + 1 + word.length <= width) {
            current += ` ${word}`;
        } else {
            out.push(current);
            current = word;
        }
    }
    if (current) {
        out.push(current);
    }

    return out;
}

function collapseBlankRuns(lines: string[]): string[] {
    const out: string[] = [];
    let blank: boolean = false;
    for (const line of lines) {
        if (line === "") {
            if (blank) {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        out.push(line);
    }

    // Trim leading/trailing blank lines.
    while (out.length > 0 && out[0] === "") {
        out.shift();
    }
    while (out.length > 0 && out[out.length - 1] === "") {
        out.pop();
    }

    return out;
}
