// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as hljs from "highlight.js";
import * as MarkdownIt from "markdown-it";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { isWindows } from "../utils/osUtils";

type RenderRule = (tokens: any[], idx: number, options: any, env: any, self: any) => string;

class MarkdownEngine implements vscode.Disposable {

    private engine: MarkdownIt;
    private config: MarkdownConfiguration;
    private listener: vscode.Disposable;

    public constructor() {
        this.reload();
        this.listener = vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("markdown")) {
                this.reload();
            }
        }, this);
    }

    public get localResourceRoots(): vscode.Uri[] {
        return [
            vscode.Uri.file(path.join(this.config.extRoot, "media")),
            vscode.Uri.file(this.katexDistDir),
        ];
    }

    // KaTeX ships its stylesheet + web fonts in its dist folder; expose them to
    // the webview so the math rendered by textRenderer is styled. The relative
    // `fonts/…` URLs inside katex.min.css resolve against this same root.
    public get katexDistDir(): string {
        // Compiled location: <ext>/out/src/webview/markdownEngine.js
        return path.join(__dirname, "..", "..", "..", "node_modules", "katex", "dist");
    }

    public getKatexStyle(): string {
        const cssPath: vscode.Uri = vscode.Uri.file(path.join(this.katexDistDir, "katex.min.css")).with({ scheme: "vscode-resource" });
        return `<link rel="stylesheet" type="text/css" href="${cssPath.toString()}">`;
    }

    public dispose(): void {
        this.listener.dispose();
    }

    public reload(): void {
        this.engine = this.initEngine();
        this.config = new MarkdownConfiguration();
    }

    public render(md: string, env?: any): string {
        return this.engine.render(md, env);
    }

    public getStyles(): string {
        return [
            this.getBuiltinStyles(),
            this.getSettingsStyles(),
        ].join(os.EOL);
    }

    private getBuiltinStyles(): string {
        let styles: vscode.Uri[] = [];
        try {
            const stylePaths: string[] = require(path.join(this.config.extRoot, "package.json"))["contributes"]["markdown.previewStyles"];
            styles = stylePaths.map((p: string) => vscode.Uri.file(path.join(this.config.extRoot, p)).with({ scheme: "vscode-resource" }));
        } catch (error) {
            leetCodeChannel.appendLine("[Error] Fail to load built-in markdown style file.");
        }
        return styles.map((style: vscode.Uri) => `<link rel="stylesheet" type="text/css" href="${style.toString()}">`).join(os.EOL);
    }

    private getSettingsStyles(): string {
        return [
            `<style>`,
            `body {`,
            `    ${this.config.fontFamily ? `font-family: ${this.config.fontFamily};` : ``}`,
            `    ${isNaN(this.config.fontSize) ? `` : `font-size: ${this.config.fontSize}px;`}`,
            `    ${isNaN(this.config.lineHeight) ? `` : `line-height: ${this.config.lineHeight};`}`,
            `}`,
            `</style>`,
        ].join(os.EOL);
    }

    private initEngine(): MarkdownIt {
        const md: MarkdownIt = new MarkdownIt({
            linkify: true,
            typographer: true,
            highlight: (code: string, lang?: string): string => {
                switch (lang && lang.toLowerCase()) {
                    case "mysql":
                        lang = "sql"; break;
                    case "json5":
                        lang = "json"; break;
                    case "python3":
                        lang = "python"; break;
                }
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(lang, code, true).value;
                    } catch (error) { /* do not highlight */ }
                }
                return ""; // use external default escaping
            },
        });

        this.addCodeBlockHighlight(md);
        this.addImageUrlCompletion(md);
        // NOTE: we intentionally keep markdown-it's DEFAULT validateLink (which
        // blocks javascript:/vbscript:/data: links). Earlier code widened it to
        // also allow file: URLs; that was removed because the only untrusted
        // markdown rendered through this engine is the community-solution body,
        // where a file: link is a phishing / NTLM-leak vector (e.g.
        // file://attacker-host/share on Windows) with no legitimate use. The
        // problem description is rendered as HTML via renderDescriptionHtml(), not
        // through markdown-it, so nothing depends on file: support. (A2-6.)
        return md;
    }

    private addCodeBlockHighlight(md: MarkdownIt): void {
        const codeBlock: RenderRule = md.renderer.rules["code_block"] ||
            ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
        // tslint:disable-next-line:typedef
        md.renderer.rules["code_block"] = (tokens, idx, options, env, self) => {
            // if any token uses lang-specified code fence, then do not highlight code block
            if (tokens.some((token: any) => token.type === "fence")) {
                return codeBlock(tokens, idx, options, env, self);
            }
            // otherwise, highlight with default lang in env object.
            const highlighted: string = options.highlight!(tokens[idx].content, env.lang, "");
            return [
                `<pre><code ${self.renderAttrs(tokens[idx])} >`,
                highlighted || md.utils.escapeHtml(tokens[idx].content),
                "</code></pre>",
            ].join(os.EOL);
        };
    }

    private addImageUrlCompletion(md: MarkdownIt): void {
        const image: RenderRule = md.renderer.rules["image"] ||
            ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
        // tslint:disable-next-line:typedef
        md.renderer.rules["image"] = (tokens, idx, options, env, self) => {
            const imageSrc: string[] | undefined = tokens[idx].attrs?.find((value: string[]) => value[0] === "src");
            if (env.host && imageSrc && imageSrc[1].startsWith("/")) {
                imageSrc[1] = `${env.host}${imageSrc[1]}`;
            }
            return image(tokens, idx, options, env, self);
        };
    }

}

// tslint:disable-next-line: max-classes-per-file
class MarkdownConfiguration {

    public readonly extRoot: string; // root path of vscode built-in markdown extension
    public readonly lineHeight: number;
    public readonly fontSize: number;
    public readonly fontFamily: string;

    public constructor() {
        const markdownConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("markdown", null);
        this.extRoot = path.join(vscode.env.appRoot, "extensions", "markdown-language-features");
        this.lineHeight = Math.max(0.6, +markdownConfig.get<number>("preview.lineHeight", NaN));
        this.fontSize = Math.max(8, +markdownConfig.get<number>("preview.fontSize", NaN));
        this.fontFamily = this.resolveFontFamily(markdownConfig);
    }

    private resolveFontFamily(config: vscode.WorkspaceConfiguration): string {
        let fontFamily: string = config.get<string>("preview.fontFamily", "");
        if (isWindows() && fontFamily === config.inspect<string>("preview.fontFamily")!.defaultValue) {
            fontFamily = `${fontFamily}, 'Microsoft Yahei UI'`;
        }
        return fontFamily;
    }
}

export const markdownEngine: MarkdownEngine = new MarkdownEngine();
