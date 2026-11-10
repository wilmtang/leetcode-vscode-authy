// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HLJSApi, LanguageFn } from "highlight.js";
import MarkdownIt = require("markdown-it");
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { isWindows } from "../utils/osUtils";

type RenderRule = (tokens: any[], idx: number, options: any, env: any, self: any) => string;

/* tslint:disable:no-var-requires */
const hljs: HLJSApi = require("highlight.js/lib/core");
const bash: LanguageFn = require("highlight.js/lib/languages/bash");
const cpp: LanguageFn = require("highlight.js/lib/languages/cpp");
const csharp: LanguageFn = require("highlight.js/lib/languages/csharp");
const go: LanguageFn = require("highlight.js/lib/languages/go");
const java: LanguageFn = require("highlight.js/lib/languages/java");
const javascript: LanguageFn = require("highlight.js/lib/languages/javascript");
const json: LanguageFn = require("highlight.js/lib/languages/json");
const kotlin: LanguageFn = require("highlight.js/lib/languages/kotlin");
const php: LanguageFn = require("highlight.js/lib/languages/php");
const python: LanguageFn = require("highlight.js/lib/languages/python");
const ruby: LanguageFn = require("highlight.js/lib/languages/ruby");
const rust: LanguageFn = require("highlight.js/lib/languages/rust");
const sql: LanguageFn = require("highlight.js/lib/languages/sql");
const swift: LanguageFn = require("highlight.js/lib/languages/swift");
const typescript: LanguageFn = require("highlight.js/lib/languages/typescript");
/* tslint:enable:no-var-requires */

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);

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
        // Bundled location: <ext>/out/extension.js. The build copies only the
        // stylesheet and fonts that the webview needs beside the bundle.
        return path.join(__dirname, "katex");
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

    public getStyles(nonce?: string): string {
        return [
            this.getBuiltinStyles(),
            this.getSettingsStyles(nonce),
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

    private getSettingsStyles(nonce?: string): string {
        return [
            `<style${nonce ? ` nonce="${nonce}"` : ""}>`,
            `body {`,
            `    ${this.config.fontFamily ? `font-family: ${serializeCssFontFamily(this.config.fontFamily)};` : ``}`,
            `    tab-size: 4;`,
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
                        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                    } catch (error) { /* do not highlight */ }
                }
                return ""; // use external default escaping
            },
        });

        this.addCodeBlockHighlight(md);
        this.addImageUrlCompletion(md);
        // Keep markdown-it's default validateLink and run rendered remote markup
        // through textRenderer's parser-based allow-list as a second boundary.
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
        // inspect() returns undefined when the setting is not registered (e.g. the
        // built-in markdown extension is disabled), so never assume it exists.
        const inspected = config.inspect<string>("preview.fontFamily");
        if (isWindows() && inspected && fontFamily === inspected.defaultValue) {
            fontFamily = `${fontFamily}, 'Microsoft Yahei UI'`;
        }
        return fontFamily;
    }
}

// Serialize a setting into a CSS declaration value without allowing it to end
// the declaration or the enclosing style element. Escaping every non-identifier
// character as a CSS code point preserves quoted family names and separators.
export function serializeCssFontFamily(value: string): string {
    return (value || "").replace(/[^a-zA-Z0-9 _-]/g, (character: string) =>
        `\\${character.charCodeAt(0).toString(16)} `,
    );
}

export const markdownEngine: MarkdownEngine = new MarkdownEngine();
