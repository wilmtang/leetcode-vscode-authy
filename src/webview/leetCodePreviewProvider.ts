// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as crypto from "crypto";
import { commands, ViewColumn } from "vscode";
import { getLeetCodeEndpoint } from "../commands/plugin";
import { ILeetCodeQuestionDetail } from "../request/leetcode-api";
import { Endpoint, getUrl, IProblem } from "../shared";
import { ILeetCodeWebviewOption, LeetCodeWebview } from "./LeetCodeWebview";
import { markdownEngine } from "./markdownEngine";
import { renderDescriptionHtml } from "./textRenderer";

class LeetCodePreviewProvider extends LeetCodeWebview {
    protected readonly viewType: string = "leetcode.preview";
    private node: IProblem;
    private description: IDescription;
    private sideMode: boolean = false;

    public isSideMode(): boolean {
        return this.sideMode;
    }

    public show(detail: ILeetCodeQuestionDetail, node: IProblem, isSideMode: boolean = false): void {
        this.description = this.buildDescription(detail, node);
        this.node = node;
        this.sideMode = isSideMode;
        this.showWebviewInternal();
    }

    protected getWebviewOption(): ILeetCodeWebviewOption {
        if (!this.sideMode) {
            return {
                title: `${this.node.name}: Preview`,
                viewColumn: ViewColumn.One,
            };
        } else {
            return {
                title: "Description",
                viewColumn: ViewColumn.Two,
                preserveFocus: true,
            };
        }
    }

    protected getWebviewContent(): string {
        const button: { element: string; script: string; style: string } = {
            element: `<button id="solve">Code Now</button>`,
            script: `const button = document.getElementById('solve');
                    button.onclick = () => vscode.postMessage({
                        command: 'ShowProblem',
                    });`,
            style: `<style>
                #solve {
                    position: fixed;
                    bottom: 1rem;
                    right: 1rem;
                    border: 0;
                    margin: 1rem 0;
                    padding: 0.2rem 1rem;
                    color: white;
                    background-color: var(--vscode-button-background);
                }
                #solve:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                #solve:active {
                    border: 0;
                }
                </style>`,
        };
        const { title, url, category, difficulty, likes, dislikes, body } = this.description;
        const head: string = markdownEngine.render(`# [${title}](${url})`);
        const info: string = markdownEngine.render(
            [
                `| Category | Difficulty | Likes | Dislikes |`,
                `| :------: | :--------: | :---: | :------: |`,
                `| ${category} | ${difficulty} | ${likes} | ${dislikes} |`,
            ].join("\n")
        );
        const tags: string = [
            `<details>`,
            `<summary><strong>Tags</strong></summary>`,
            markdownEngine.render(this.description.tags.map((t: string) => `[\`${t}\`](${this.getTagLink(t)})`).join(" | ")),
            `</details>`,
        ].join("\n");
        const companies: string = [
            `<details>`,
            `<summary><strong>Companies</strong></summary>`,
            markdownEngine.render(this.description.companies.map((c: string) => `\`${c}\``).join(" | ")),
            `</details>`,
        ].join("\n");
        const links: string = markdownEngine.render(`[Submissions](${this.getSubmissionsLink(url)}) | [Solution](${this.getSolutionsLink(url)})`);
        // Nonce the extension's own inline script so the CSP can drop
        // 'unsafe-inline' for scripts — any script/handler injected through the
        // untrusted description HTML then cannot execute, even if the sanitizer is
        // bypassed.
        const nonce: string = crypto.randomBytes(16).toString("base64");
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src vscode-resource: 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline'; font-src vscode-resource:;"/>
                ${markdownEngine.getStyles()}
                ${markdownEngine.getKatexStyle()}
                ${!this.sideMode ? button.style : ""}
                <style>
                    code { white-space: pre-wrap; }
                </style>
            </head>
            <body>
                ${head}
                ${info}
                ${tags}
                ${companies}
                ${body}
                <hr />
                ${links}
                ${!this.sideMode ? button.element : ""}
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    ${!this.sideMode ? button.script : ""}
                </script>
            </body>
            </html>
        `;
    }

    protected onDidDisposeWebview(): void {
        super.onDidDisposeWebview();
        this.sideMode = false;
    }

    protected async onDidReceiveMessage(message: IWebViewMessage): Promise<void> {
        switch (message.command) {
            case "ShowProblem": {
                await commands.executeCommand("leetcode.showProblem", this.node);
                break;
            }
        }
    }

    // private async hideSideBar(): Promise<void> {
    //     await commands.executeCommand("workbench.action.focusSideBar");
    //     await commands.executeCommand("workbench.action.toggleSidebarVisibility");
    // }

    private buildDescription(detail: ILeetCodeQuestionDetail, problem: IProblem): IDescription {
        const slug: string = detail.titleSlug || problem.titleSlug || "";
        return {
            title: detail.title || problem.name,
            url: `${getUrl("base")}/problems/${slug}/description/`,
            tags: problem.tags,
            companies: problem.companies,
            category: detail.categoryTitle,
            difficulty: detail.difficulty,
            likes: String(detail.likes),
            dislikes: String(detail.dislikes),
            body: renderDescriptionHtml(detail.content),
        };
    }

    private getTagLink(tag: string): string {
        const endPoint: string = getLeetCodeEndpoint();
        if (endPoint === Endpoint.LeetCodeCN) {
            return `https://leetcode.cn/tag/${tag}?source=vscode`;
        } else if (endPoint === Endpoint.LeetCode) {
            return `https://leetcode.com/tag/${tag}?source=vscode`;
        }

        return "https://leetcode.com?source=vscode";
    }

    private getSolutionsLink(url: string): string {
        return url.replace("/description/", "/solutions/") + "?source=vscode";
    }
    private getSubmissionsLink(url: string): string {
        return url.replace("/description/", "/submissions/") + "?source=vscode";
    }
}

interface IDescription {
    title: string;
    url: string;
    tags: string[];
    companies: string[];
    category: string;
    difficulty: string;
    likes: string;
    dislikes: string;
    body: string;
}

interface IWebViewMessage {
    command: string;
}

export const leetCodePreviewProvider: LeetCodePreviewProvider = new LeetCodePreviewProvider();
