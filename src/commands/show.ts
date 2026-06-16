// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as _ from "lodash";
import * as path from "path";
import * as vscode from "vscode";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import { getQuestionDetail, getTopSolutionArticle, ILeetCodeCodeSnippet, ILeetCodeQuestionDetail, ILeetCodeSolutionArticle } from "../request/leetcode-api";
import { ISolutionFileMeta, parseSolutionFile } from "../request/leetcode-http";
import { Endpoint, getUrl, IProblem, IQuickItemEx, languages, PREMIUM_URL_CN, PREMIUM_URL_GLOBAL, ProblemState } from "../shared";
import { genFileExt, genFileName, getNodeIdFromFile } from "../utils/problemUtils";
import { generateSolutionFileContent } from "../utils/solutionFileGenerator";
import * as settingUtils from "../utils/settingUtils";
import { IDescriptionConfiguration } from "../utils/settingUtils";
import {
    DialogOptions,
    DialogType,
    openSettingsEditor,
    openUrl,
    promptForOpenOutputChannel,
    promptForSignIn,
    promptHintMessage,
} from "../utils/uiUtils";
import { getActiveFilePath, selectWorkspaceFolder } from "../utils/workspaceUtils";
import * as wsl from "../utils/wslUtils";
import { leetCodePreviewProvider } from "../webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "../webview/leetCodeSolutionProvider";
import { getLeetCodeEndpoint } from "./plugin";
import { globalState } from "../globalState";

export async function previewProblem(input: IProblem | vscode.Uri, isSideMode: boolean = false, prefetched?: ILeetCodeQuestionDetail): Promise<void> {
    let node: IProblem;

    if (input instanceof vscode.Uri) {
        const activeFilePath: string = input.fsPath;
        const id: string = await getNodeIdFromFile(activeFilePath);
        if (!id) {
            vscode.window.showErrorMessage(`Failed to resolve the problem id from file: ${activeFilePath}.`);
            return;
        }
        const cachedNode: IProblem | undefined = explorerNodeManager.getNodeById(id);
        if (!cachedNode) {
            vscode.window.showErrorMessage(`Failed to resolve the problem with id: ${id}.`);
            return;
        }
        node = cachedNode;
        // Move the preview page aside if it's triggered from Code Lens
        isSideMode = true;
    } else {
        node = input;
        const { isPremium } = globalState.getUserStatus() ?? {};
        if (input.locked && !isPremium) {
            const url = getLeetCodeEndpoint() === Endpoint.LeetCode ? PREMIUM_URL_GLOBAL : PREMIUM_URL_CN;
            openUrl(url);
            return;
        }
    }

    const slug: string | undefined = node.titleSlug;
    if (!slug) {
        vscode.window.showErrorMessage(`Failed to resolve the problem slug for: ${node.name}.`);
        return;
    }

    try {
        // Reuse the detail already fetched while generating the file (when opening
        // a problem with the webview description) instead of fetching it twice.
        const needTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
        const detail: ILeetCodeQuestionDetail = prefetched || await getQuestionDetail(slug, needTranslation);
        leetCodePreviewProvider.show(detail, node, isSideMode);
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to fetch the problem description. Please open the output channel for details.", DialogType.error);
    }
}

export async function pickOne(): Promise<void> {
    const problems: IProblem[] = await explorerNodeManager.getProblems();
    if (problems.length === 0) {
        return;
    }
    const randomProblem: IProblem = problems[Math.floor(Math.random() * problems.length)];
    await showProblemInternal(randomProblem);
}

export async function showProblem(node?: LeetCodeNode): Promise<void> {
    if (!node) {
        return;
    }
    await showProblemInternal(node);
}

export async function searchProblem(): Promise<void> {
    if (!leetCodeManager.getUser()) {
        promptForSignIn();
        return;
    }
    // Resolve the (cached) catalog first, then open the quick pick on a ready
    // array — so the picker never sits on an unresolved promise (which could spin
    // forever) and reuses the explorer cache instead of a fresh ~20s fetch.
    const problems: IProblem[] = await explorerNodeManager.getProblems();
    const choice: IQuickItemEx<IProblem> | undefined = await vscode.window.showQuickPick(parseProblemsToPicks(problems), {
        matchOnDetail: true,
        placeHolder: "Select one problem",
    });
    if (!choice) {
        return;
    }
    await showProblemInternal(choice.value);
}

export async function showSolution(input: LeetCodeNode | vscode.Uri): Promise<void> {
    const target: ISolutionTarget | undefined = await resolveSolutionTarget(input);
    if (!target) {
        vscode.window.showErrorMessage("Invalid input to fetch the solution data.");
        return;
    }

    const language: string | undefined = await fetchProblemLanguage();
    if (!language) {
        return;
    }
    try {
        const article: ILeetCodeSolutionArticle | undefined = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification },
            async (p: vscode.Progress<{ message?: string }>) => {
                p.report({ message: "Fetching top voted solution from discussions..." });
                return getTopSolutionArticle(target.titleSlug, language);
            },
        );
        if (!article) {
            vscode.window.showInformationMessage(`No community solution was found for "${target.name}".`);
            return;
        }
        leetCodeSolutionProvider.show(article, target.name);
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to fetch the top voted solution. Please open the output channel for details.", DialogType.error);
    }
}

interface ISolutionTarget {
    titleSlug: string;
    name: string;
}

// Resolves the problem slug + display name from however showSolution was
// triggered: an explorer node carries both directly; a file path is resolved via
// its frontend id to a cached node, falling back to the slug embedded in the
// file's @lc header (parseSolutionFile) when the explorer cache misses.
async function resolveSolutionTarget(input: LeetCodeNode | vscode.Uri): Promise<ISolutionTarget | undefined> {
    if (input instanceof LeetCodeNode) {
        return input.titleSlug ? { titleSlug: input.titleSlug, name: input.name } : undefined;
    }

    const filePath: string | undefined = input instanceof vscode.Uri ? input.fsPath : await getActiveFilePath();
    if (!filePath) {
        return undefined;
    }

    const id: string = await getNodeIdFromFile(filePath);
    const node: IProblem | undefined = id ? explorerNodeManager.getNodeById(id) : undefined;
    if (node && node.titleSlug) {
        return { titleSlug: node.titleSlug, name: node.name };
    }

    try {
        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        return { titleSlug: meta.slug, name: node ? node.name : meta.slug };
    } catch (error) {
        return undefined;
    }
}

async function fetchProblemLanguage(): Promise<string | undefined> {
    const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    let defaultLanguage: string | undefined = leetCodeConfig.get<string>("defaultLanguage");
    if (defaultLanguage && languages.indexOf(defaultLanguage) < 0) {
        defaultLanguage = undefined;
    }
    const language: string | undefined =
        defaultLanguage ||
        (await vscode.window.showQuickPick(languages, {
            placeHolder: "Select the language you want to use",
            ignoreFocusOut: true,
        }));
    // fire-and-forget default language query
    (async (): Promise<void> => {
        if (language && !defaultLanguage && leetCodeConfig.get<boolean>("hint.setDefaultLanguage")) {
            const choice: vscode.MessageItem | undefined = await vscode.window.showInformationMessage(
                `Would you like to set '${language}' as your default language?`,
                DialogOptions.yes,
                DialogOptions.no,
                DialogOptions.never
            );
            if (choice === DialogOptions.yes) {
                leetCodeConfig.update("defaultLanguage", language, true /* UserSetting */);
            } else if (choice === DialogOptions.never) {
                leetCodeConfig.update("hint.setDefaultLanguage", false, true /* UserSetting */);
            }
        }
    })();
    return language;
}

async function showProblemInternal(node: IProblem): Promise<void> {
    try {
        const language: string | undefined = await fetchProblemLanguage();
        if (!language) {
            return;
        }

        const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const workspaceFolder: string = await selectWorkspaceFolder();
        if (!workspaceFolder) {
            return;
        }

        const fileFolder: string = leetCodeConfig
            .get<string>(`filePath.${language}.folder`, leetCodeConfig.get<string>(`filePath.default.folder`, ""))
            .trim();
        const fileName: string = leetCodeConfig
            .get<string>(`filePath.${language}.filename`, leetCodeConfig.get<string>(`filePath.default.filename`) || genFileName(node, language))
            .trim();

        let finalPath: string = path.join(workspaceFolder, fileFolder, fileName);

        if (finalPath) {
            finalPath = await resolveRelativePath(finalPath, node, language);
            if (!finalPath) {
                leetCodeChannel.appendLine("Showing problem canceled by user.");
                return;
            }
        }

        finalPath = wsl.useWsl() ? await wsl.toWinPath(finalPath) : finalPath;

        const descriptionConfig: IDescriptionConfiguration = settingUtils.getDescriptionConfiguration();
        const needTranslation: boolean = settingUtils.shouldUseEndpointTranslation();

        const detail: ILeetCodeQuestionDetail | undefined = await generateProblemFile(node, language, finalPath, descriptionConfig.showInComment, needTranslation);
        const promises: any[] = [
            vscode.window.showTextDocument(vscode.Uri.file(finalPath), {
                preview: false,
                viewColumn: vscode.ViewColumn.One,
            }),
            promptHintMessage(
                "hint.commentDescription",
                'You can config how to show the problem description through "leetcode.showDescription".',
                "Open settings",
                (): Promise<any> => openSettingsEditor("leetcode.showDescription")
            ),
        ];
        if (descriptionConfig.showInWebview) {
            promises.push(showDescriptionView(node, detail));
        }

        await Promise.all(promises);
    } catch (error) {
        await promptForOpenOutputChannel(`${error} Please open the output channel for details.`, DialogType.error);
    }
}

// Generates the solution file directly from the API (replacing the CLI
// `show -c/-cx`). The canonical problem URL is embedded in the @lc header so the
// already-migrated submit/test parseSlug() recovers the slug for any filename.
// Returns the fetched detail so the caller can reuse it for the webview preview
// (avoiding a second getQuestionDetail call); returns undefined when the file
// already exists and nothing was fetched.
async function generateProblemFile(
    node: IProblem,
    language: string,
    filePath: string,
    showDescriptionInComment: boolean,
    needTranslation: boolean,
): Promise<ILeetCodeQuestionDetail | undefined> {
    if (await fse.pathExists(filePath)) {
        return undefined;
    }

    const slug: string | undefined = node.titleSlug;
    if (!slug) {
        throw new Error(`Cannot resolve the problem slug for "${node.name}".`);
    }

    const detail: ILeetCodeQuestionDetail = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification },
        async (p: vscode.Progress<{ message?: string }>) => {
            p.report({ message: "Fetching problem data..." });
            return getQuestionDetail(slug, needTranslation);
        },
    );

    // The generated code body is empty when LeetCode has no snippet for the
    // chosen language; warn (don't block) so the empty scaffold is explained.
    if (!detail.codeSnippets.some((snippet: ILeetCodeCodeSnippet) => snippet.langSlug === language)) {
        vscode.window.showWarningMessage(`LeetCode has no ${language} code template for "${node.name}"; generated an empty file.`);
    }

    await fse.createFile(filePath);
    await fse.writeFile(filePath, generateSolutionFileContent({
        detail,
        language,
        frontendId: node.id,
        showDescriptionInComment,
        endpointBase: getUrl("base"),
    }));

    return detail;
}

async function showDescriptionView(node: IProblem, detail?: ILeetCodeQuestionDetail): Promise<void> {
    return previewProblem(node, vscode.workspace.getConfiguration("leetcode").get<boolean>("enableSideMode", true), detail);
}
function parseProblemsToPicks(problems: IProblem[]): Array<IQuickItemEx<IProblem>> {
    return problems.map((problem: IProblem) => ({
        label: `${parseProblemDecorator(problem.state, problem.locked)}${problem.id}.${problem.name}`,
        description: "",
        detail: `AC rate: ${problem.passRate}, Difficulty: ${problem.difficulty}`,
        value: problem,
    }));
}

function parseProblemDecorator(state: ProblemState, locked: boolean): string {
    switch (state) {
        case ProblemState.AC:
            return "$(check) ";
        case ProblemState.NotAC:
            return "$(x) ";
        default:
            return locked ? "$(lock) " : "";
    }
}

async function resolveRelativePath(relativePath: string, node: IProblem, selectedLanguage: string): Promise<string> {
    let tag: string = "";
    if (/\$\{tag\}/i.test(relativePath)) {
        tag = (await resolveTagForProblem(node)) || "";
    }

    let company: string = "";
    if (/\$\{company\}/i.test(relativePath)) {
        company = (await resolveCompanyForProblem(node)) || "";
    }

    return relativePath.replace(/\$\{(.*?)\}/g, (_substring: string, ...args: string[]) => {
        const placeholder: string = args[0].toLowerCase().trim();
        switch (placeholder) {
            case "id":
                return node.id;
            case "name":
                return node.name;
            case "camelcasename":
                return _.camelCase(node.name);
            case "pascalcasename":
                return _.upperFirst(_.camelCase(node.name));
            case "kebabcasename":
            case "kebab-case-name":
                return _.kebabCase(node.name);
            case "snakecasename":
            case "snake_case_name":
                return _.snakeCase(node.name);
            case "ext":
                return genFileExt(selectedLanguage);
            case "language":
                return selectedLanguage;
            case "difficulty":
                return node.difficulty.toLocaleLowerCase();
            case "tag":
                return tag;
            case "company":
                return company;
            default:
                const errorMsg: string = `The config '${placeholder}' is not supported.`;
                leetCodeChannel.appendLine(errorMsg);
                throw new Error(errorMsg);
        }
    });
}

async function resolveTagForProblem(problem: IProblem): Promise<string | undefined> {
    if (problem.tags.length === 1) {
        return problem.tags[0];
    }
    return await vscode.window.showQuickPick(problem.tags, {
        matchOnDetail: true,
        placeHolder: "Multiple tags available, please select one",
        ignoreFocusOut: true,
    });
}

async function resolveCompanyForProblem(problem: IProblem): Promise<string | undefined> {
    if (problem.companies.length === 1) {
        return problem.companies[0];
    }
    return await vscode.window.showQuickPick(problem.companies, {
        matchOnDetail: true,
        placeHolder: "Multiple tags available, please select one",
        ignoreFocusOut: true,
    });
}
