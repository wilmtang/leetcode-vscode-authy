// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as crypto from "crypto";
import { ViewColumn } from "vscode";
import { ILeetCodeSolutionArticle } from "../request/leetcode-api";
import { getUrl } from "../shared";
import { leetCodePreviewProvider } from "./leetCodePreviewProvider";
import { ILeetCodeWebviewOption, LeetCodeWebview } from "./LeetCodeWebview";
import { markdownEngine } from "./markdownEngine";
import { extractMathPlaceholders, IMathExtraction, restoreMath, sanitizeHtml, stripMarkdownHtmlComments } from "./textRenderer";

class LeetCodeSolutionProvider extends LeetCodeWebview {

    protected readonly viewType: string = "leetcode.solution";
    private problemName: string;
    private article: ILeetCodeSolutionArticle;

    public show(article: ILeetCodeSolutionArticle, problemName: string): void {
        this.article = article;
        this.problemName = problemName;
        this.showWebviewInternal();
    }

    protected getWebviewOption(): ILeetCodeWebviewOption {
        if (leetCodePreviewProvider.isSideMode()) {
            return {
                title: "Solution",
                viewColumn: ViewColumn.Two,
                preserveFocus: true,
            };
        } else {
            return {
                title: `Solution: ${this.problemName}`,
                viewColumn: ViewColumn.One,
            };
        }
    }

    protected getWebviewContent(): string {
        const nonce: string = crypto.randomBytes(16).toString("base64");
        const styles: string = markdownEngine.getStyles(nonce);
        const katexStyle: string = markdownEngine.getKatexStyle();
        const { title, url, author, authorSlug, upvotes } = this.article;
        const head: string = sanitizeHtml(markdownEngine.render(`# [${title}](${url})`));
        const authorLink: string = authorSlug ? `[${author}](${getUrl("base")}/u/${authorSlug}/)` : author;
        const info: string = sanitizeHtml(markdownEngine.render([
            `|  Author  |  Votes   |`,
            `| :------: | :------: |`,
            `| ${authorLink}  | ${upvotes} |`,
        ].join("\n")));
        const body: string = this.renderArticleBody(this.article.content);
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src vscode-resource: 'nonce-${nonce}'; font-src vscode-resource:;"/>
                ${styles}
                ${katexStyle}
            </head>
            <body class="vscode-body scrollBeyondLastLine wordWrap showEditorSelection">
                ${head}
                ${info}
                ${body}
            </body>
            </html>
        `;
    }

    protected onDidDisposeWebview(): void {
        super.onDidDisposeWebview();
    }

    // The solution article content is markdown (with embedded LaTeX). Pull the
    // math out first so markdown-it leaves it alone, render the markdown, sanitize
    // it, then splice the KaTeX-rendered math back in.
    private renderArticleBody(markdown: string): string {
        const extracted: IMathExtraction = extractMathPlaceholders(stripMarkdownHtmlComments(markdown || ""));
        const rendered: string = markdownEngine.render(extracted.text, { host: getUrl("base") });
        const sanitized: string = sanitizeHtml(rendered);
        return restoreMath(sanitized, extracted.math);
    }
}

export const leetCodeSolutionProvider: LeetCodeSolutionProvider = new LeetCodeSolutionProvider();
