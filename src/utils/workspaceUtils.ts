// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { IQuickItemEx } from "../shared";
import { getWorkspaceConfiguration, getWorkspaceFolder } from "./settingUtils";
import { showDirectorySelectDialog } from "./uiUtils";

export async function selectWorkspaceFolder(): Promise<string> {
    let workspaceFolderSetting: string = getWorkspaceFolder();
    if (workspaceFolderSetting.trim() === "") {
        workspaceFolderSetting = await determineLeetCodeFolder();
        if (workspaceFolderSetting === "") {
            // User cancelled
            return workspaceFolderSetting;
        }
    }
    let needAsk: boolean = true;
    await fse.ensureDir(workspaceFolderSetting);
    for (const folder of vscode.workspace.workspaceFolders || []) {
        if (isSubFolder(folder.uri.fsPath, workspaceFolderSetting)) {
            needAsk = false;
        }
    }

    if (needAsk) {
        const choice: string | undefined = await vscode.window.showQuickPick(
            [
                OpenOption.justOpenFile,
                OpenOption.openInCurrentWindow,
                OpenOption.openInNewWindow,
                OpenOption.addToWorkspace,
            ],
            { placeHolder: "The LeetCode workspace folder is not opened in VS Code, would you like to open it?" },
        );

        // Todo: generate file first
        switch (choice) {
            case OpenOption.justOpenFile:
                return workspaceFolderSetting;
            case OpenOption.openInCurrentWindow:
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFolderSetting), false);
                return "";
            case OpenOption.openInNewWindow:
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFolderSetting), true);
                return "";
            case OpenOption.addToWorkspace:
                vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(workspaceFolderSetting) });
                break;
            default:
                return "";
        }
    }

    return workspaceFolderSetting;
}

export async function getActiveFilePath(uri?: vscode.Uri): Promise<string | undefined> {
    let textEditor: vscode.TextEditor | undefined;
    if (uri) {
        textEditor = await vscode.window.showTextDocument(uri, { preview: false });
    } else {
        textEditor = vscode.window.activeTextEditor;
    }

    if (!textEditor) {
        return undefined;
    }
    if (textEditor.document.isDirty && !await textEditor.document.save()) {
        vscode.window.showWarningMessage("Please save the solution file first.");
        return undefined;
    }
    return textEditor.document.uri.fsPath;
}

export function resolvePathWithinRoot(root: string, candidate: string): string {
    const resolvedRoot: string = path.resolve(root);
    const resolvedCandidate: string = path.resolve(candidate);
    const relative: string = path.relative(resolvedRoot, resolvedCandidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Configured problem path escapes the selected LeetCode workspace: ${resolvedCandidate}`);
    }
    return resolvedCandidate;
}

export async function writeFileExclusiveWithinRoot(root: string, candidate: string, content: string): Promise<void> {
    const target: string = resolvePathWithinRoot(root, candidate);
    const physicalRoot: string = await fse.realpath(root);
    await assertExistingAncestorWithinRoot(physicalRoot, path.dirname(target));
    await fse.ensureDir(path.dirname(target));
    await assertExistingAncestorWithinRoot(physicalRoot, path.dirname(target));

    let handle: number | undefined;
    try {
        handle = await fse.open(target, "wx");
        await fse.writeFile(handle, content, "utf8");
    } catch (error) {
        if (handle !== undefined) {
            await fse.close(handle);
            handle = undefined;
            await fse.unlink(target).catch(() => undefined);
        }
        throw error;
    } finally {
        if (handle !== undefined) {
            await fse.close(handle);
        }
    }
}

async function assertExistingAncestorWithinRoot(physicalRoot: string, candidateParent: string): Promise<void> {
    let ancestor: string = candidateParent;
    while (!await fse.pathExists(ancestor)) {
        const parent: string = path.dirname(ancestor);
        if (parent === ancestor) {
            throw new Error(`Cannot resolve a physical parent for ${candidateParent}`);
        }
        ancestor = parent;
    }
    const physicalAncestor: string = await fse.realpath(ancestor);
    resolvePathWithinRoot(physicalRoot, physicalAncestor);
}

export function sanitizePathSegment(value: string): string {
    const sanitized: string = (value || "")
        .replace(/[<>:"/\\|?*\0-\x1f]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim();
    return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "_";
}

function isSubFolder(from: string, to: string): boolean {
    const relative: string = path.relative(from, to);
    if (relative === "") {
        return true;
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function determineLeetCodeFolder(): Promise<string> {
    let result: string;
    const picks: Array<IQuickItemEx<string>> = [];
    picks.push(
        {
            label: `Default location`,
            detail: `${path.join(os.homedir(), ".leetcode")}`,
            value: `${path.join(os.homedir(), ".leetcode")}`,
        },
        {
            label: "$(file-directory) Browse...",
            value: ":browse",
        },
    );
    const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(
        picks,
        { placeHolder: "Select where you would like to save your LeetCode files" },
    );
    if (!choice) {
        result = "";
    } else if (choice.value === ":browse") {
        const directory: vscode.Uri[] | undefined = await showDirectorySelectDialog();
        if (!directory || directory.length < 1) {
            result = "";
        } else {
            result = directory[0].fsPath;
        }
    } else {
        result = choice.value;
    }

    getWorkspaceConfiguration().update("workspaceFolder", result, vscode.ConfigurationTarget.Global);

    return result;
}

enum OpenOption {
    justOpenFile = "Just open the problem file",
    openInCurrentWindow = "Open in current window",
    openInNewWindow = "Open in new window",
    addToWorkspace = "Add to workspace",
}
