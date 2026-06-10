// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { codeLensController } from "./codelens/CodeLensController";
import * as cache from "./commands/cache";
import { switchDefaultLanguage } from "./commands/language";
import * as plugin from "./commands/plugin";
import * as session from "./commands/session";
import * as show from "./commands/show";
import * as star from "./commands/star";
import * as submit from "./commands/submit";
import * as test from "./commands/test";
import {
    AuthSyncForceStartResult,
    AuthSyncOwnerInfo,
    authSyncServer,
    IAuthSyncStatusSnapshot,
} from "./auth/authSyncServer";
import { IAuthSyncPortConflict } from "./auth/authSyncPortInspector";
import { explorerNodeManager } from "./explorer/explorerNodeManager";
import { LeetCodeNode } from "./explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "./explorer/LeetCodeTreeDataProvider";
import { leetCodeTreeItemDecorationProvider } from "./explorer/LeetCodeTreeItemDecorationProvider";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { leetCodeManager } from "./leetCodeManager";
import { leetCodeStatusBarController } from "./statusbar/leetCodeStatusBarController";
import { DialogType, promptForOpenOutputChannel } from "./utils/uiUtils";
import { leetCodePreviewProvider } from "./webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "./webview/leetCodeSolutionProvider";
import { leetCodeSubmissionProvider } from "./webview/leetCodeSubmissionProvider";
import { markdownEngine } from "./webview/markdownEngine";
import TrackData from "./utils/trackingUtils";
import { globalState } from "./globalState";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    try {
        if (!(await leetCodeExecutor.meetRequirements(context))) {
            throw new Error("The environment doesn't meet requirements.");
        }

        leetCodeManager.on("statusChanged", () => {
            leetCodeStatusBarController.updateStatusBar(leetCodeManager.getStatus(), leetCodeManager.getUser());
            leetCodeTreeDataProvider.refresh();
        });

        leetCodeTreeDataProvider.initialize(context);
        globalState.initialize(context);

        context.subscriptions.push(
            leetCodeStatusBarController,
            leetCodeChannel,
            leetCodePreviewProvider,
            leetCodeSubmissionProvider,
            leetCodeSolutionProvider,
            leetCodeExecutor,
            markdownEngine,
            codeLensController,
            explorerNodeManager,
            vscode.window.registerFileDecorationProvider(leetCodeTreeItemDecorationProvider),
            vscode.window.createTreeView("leetCodeExplorer", { treeDataProvider: leetCodeTreeDataProvider, showCollapseAll: true }),
            vscode.commands.registerCommand("leetcode.deleteCache", () => cache.deleteCache()),
            vscode.commands.registerCommand("leetcode.toggleLeetCodeCn", () => plugin.switchEndpoint()),
            vscode.commands.registerCommand("leetcode.signin", () => leetCodeManager.signIn()),
            vscode.commands.registerCommand("leetcode.signout", () => leetCodeManager.signOut()),
            vscode.commands.registerCommand("leetcode.manageSessions", () => session.manageSessions()),
            vscode.commands.registerCommand("leetcode.previewProblem", (node: LeetCodeNode) => {
                TrackData.report({
                    event_key: "vscode_open_problem",
                    type: "click",
                    extra: JSON.stringify({
                        problem_id: node.id,
                        problem_name: node.name,
                    }),
                });
                show.previewProblem(node);
            }),
            vscode.commands.registerCommand("leetcode.showProblem", (node: LeetCodeNode) => show.showProblem(node)),
            vscode.commands.registerCommand("leetcode.pickOne", () => show.pickOne()),
            vscode.commands.registerCommand("leetcode.searchProblem", () => show.searchProblem()),
            vscode.commands.registerCommand("leetcode.showSolution", (input: LeetCodeNode | vscode.Uri) => show.showSolution(input)),
            vscode.commands.registerCommand("leetcode.refreshExplorer", () => leetCodeTreeDataProvider.refresh()),
            vscode.commands.registerCommand("leetcode.testSolution", (uri?: vscode.Uri) => {
                TrackData.report({
                    event_key: "vscode_runCode",
                    type: "click",
                });
                return test.testSolution(uri);
            }),
            vscode.commands.registerCommand("leetcode.submitSolution", (uri?: vscode.Uri) => {
                TrackData.report({
                    event_key: "vscode_submit",
                    type: "click",
                });
                return submit.submitSolution(uri);
            }),
            vscode.commands.registerCommand("leetcode.switchDefaultLanguage", () => switchDefaultLanguage()),
            vscode.commands.registerCommand("leetcode.addFavorite", (node: LeetCodeNode) => star.addFavorite(node)),
            vscode.commands.registerCommand("leetcode.removeFavorite", (node: LeetCodeNode) => star.removeFavorite(node)),
            vscode.commands.registerCommand("leetcode.problems.sort", () => plugin.switchSortingStrategy()),
            vscode.commands.registerCommand("leetcode.authSync.status", () => showAuthSyncStatus()),
            vscode.commands.registerCommand("leetcode.authSync.restart", () => restartAuthSyncServer()),
            vscode.commands.registerCommand("leetcode.authSync.forceStart", () => forceStartAuthSyncServer()),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (
                    event.affectsConfiguration("leetcode.authSync.enabled") ||
                    event.affectsConfiguration("leetcode.authSync.port") ||
                    event.affectsConfiguration("leetcode.authSync.secret") ||
                    event.affectsConfiguration("leetcode.authSync.ownerHeartbeatIntervalSeconds") ||
                    event.affectsConfiguration("leetcode.authSync.observerCheckIntervalSeconds")
                ) {
                    void restartAuthSyncServer(false);
                }
            }),
            authSyncServer
        );

        await leetCodeExecutor.switchEndpoint(plugin.getLeetCodeEndpoint());
        await leetCodeManager.getLoginStatus();
        vscode.window.registerUriHandler({ handleUri: leetCodeManager.handleUriSignIn });
        await startAuthSyncServer();
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        promptForOpenOutputChannel("Extension initialization failed. Please open output channel for details.", DialogType.error);
    }
}

export async function deactivate(): Promise<void> {
    await authSyncServer.stop();
}

async function startAuthSyncServer(): Promise<void> {
    try {
        await authSyncServer.start();
    } catch (error) {
        leetCodeChannel.appendLine(`[auth-sync] Failed to start server: ${String(error)}`);
    }
}

async function restartAuthSyncServer(showMessage: boolean = true): Promise<void> {
    try {
        await authSyncServer.stop();
        await authSyncServer.start();
        if (showMessage) {
            vscode.window.showInformationMessage("LeetCode auth sync server restarted.");
        }
    } catch (error) {
        leetCodeChannel.appendLine(`[auth-sync] Failed to restart server: ${String(error)}`);
        if (showMessage) {
            promptForOpenOutputChannel("Failed to restart LeetCode auth sync server. Please open output channel for details.", DialogType.error);
        }
    }
}

async function showAuthSyncStatus(): Promise<void> {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    const enabled: boolean = config.get<boolean>("authSync.enabled", true);
    const port: number = config.get<number>("authSync.port", 17899);
    const secret: string = config.get<string>("authSync.secret", "");
    await authSyncServer.refreshStatus();
    const snapshot: IAuthSyncStatusSnapshot = authSyncServer.getStatusSnapshot();
    const activePort: number | undefined = snapshot.port ?? authSyncServer.getPort();
    const lastSyncedAt: number | undefined = globalState.getAuthSyncLastSyncedAt();

    let serverStatus: string;
    if (!enabled) {
        serverStatus = "Disabled";
    } else if (snapshot.mode === "local") {
        serverStatus = `Listening on port ${activePort ?? port} in this window (${formatCurrentWindow(snapshot)})`;
    } else if (snapshot.mode === "observer") {
        serverStatus = `Observer on port ${activePort ?? port}. Owner window: ${formatOwner(snapshot.owner)}. This window: ${formatCurrentWindow(snapshot)}`;
    } else if (snapshot.mode === "conflict") {
        const conflict: string = snapshot.conflict ? ` Used by ${snapshot.conflict.summary}.` : "";
        serverStatus = `Not running because port ${activePort ?? port} is used by another program.${conflict}`;
    } else if (snapshot.mode === "vacant") {
        serverStatus = `No live owner on port ${activePort ?? port}. This window will try to claim the listener on the next observer check.`;
    } else {
        serverStatus = `Not running on port ${port}`;
    }

    const lastSync: string = lastSyncedAt
        ? new Date(lastSyncedAt).toLocaleString()
        : "No cookies synced yet";
    const secretStatus: string = secret ? "configured" : "none";
    const timing: string = `heartbeat ${formatDuration(snapshot.ownershipSettings.heartbeatMs)}, observer check ${formatDuration(snapshot.ownershipSettings.observerCheckMs)}`;

    vscode.window.showInformationMessage(
        `Last sync: ${lastSync}\nAuth Sync: ${serverStatus}\nSecret: ${secretStatus}\nTiming: ${timing}`,
        { modal: true }
    );
}

async function forceStartAuthSyncServer(): Promise<void> {
    const forceStart: vscode.MessageItem = { title: "Force Start" };
    const cancel: vscode.MessageItem = { title: "Cancel", isCloseAffordance: true };
    const choice: vscode.MessageItem | undefined = await vscode.window.showWarningMessage(
        "Force this VS Code window to own the LeetCode Auth Sync port? If another VS Code window owns it, that listener will be released first.",
        { modal: true },
        forceStart,
        cancel
    );

    if (choice !== forceStart) {
        return;
    }

    const result: AuthSyncForceStartResult = await authSyncServer.forceStart();
    switch (result.kind) {
        case "disabled":
            vscode.window.showWarningMessage("Browser Auth Sync is disabled. Enable `leetcode.authSync.enabled` before force starting the listener.");
            return;
        case "started":
            vscode.window.showInformationMessage(`LeetCode auth sync server is now listening in this window on port ${result.port}.`);
            return;
        case "claimed":
            vscode.window.showInformationMessage(`LeetCode auth sync server moved to this window on port ${result.port}. Previous owner: ${formatOwner(result.previousOwner)}.`);
            return;
        case "releaseFailed":
            vscode.window.showErrorMessage(`Failed to release the current LeetCode auth sync owner${result.owner ? ` (${formatOwner(result.owner)})` : ""}: ${result.message}`);
            return;
        case "portConflict":
            await showPortConflictPrompt(result.conflict);
            return;
        default:
            return;
    }
}

async function showPortConflictPrompt(conflict: IAuthSyncPortConflict): Promise<void> {
    leetCodeChannel.appendLine("[auth-sync] Force start failed because the configured port is not owned by LeetCode Auth Sync.");
    leetCodeChannel.appendLine(conflict.details);

    const openOutput: vscode.MessageItem = { title: "Open Output" };
    const copyInspect: vscode.MessageItem = { title: "Copy Inspect Command" };
    const copyStop: vscode.MessageItem = { title: "Copy Stop Command" };
    const choices: vscode.MessageItem[] = conflict.stopCommand
        ? [openOutput, copyInspect, copyStop]
        : [openOutput, copyInspect];
    const result: vscode.MessageItem | undefined = await vscode.window.showErrorMessage(
        `Auth Sync cannot force start on port ${conflict.port}. The port is used by ${conflict.summary}, not this extension.`,
        ...choices
    );

    if (result === openOutput) {
        leetCodeChannel.show();
    } else if (result === copyInspect) {
        await vscode.env.clipboard.writeText(conflict.inspectCommand);
        vscode.window.showInformationMessage("Copied auth sync port inspect command.");
    } else if (result === copyStop && conflict.stopCommand) {
        await vscode.env.clipboard.writeText(conflict.stopCommand);
        vscode.window.showInformationMessage("Copied auth sync port stop command.");
    }
}

function formatOwner(owner: AuthSyncOwnerInfo | undefined): string {
    if (!owner) {
        return "unknown";
    }

    const heartbeat: string = owner.heartbeatAt ? new Date(owner.heartbeatAt).toLocaleString() : "unknown";
    return `${owner.windowLabel} (PID ${owner.pid}, window ${owner.windowId}, heartbeat ${heartbeat})`;
}

function formatCurrentWindow(snapshot: IAuthSyncStatusSnapshot): string {
    return `${snapshot.currentWindow.windowLabel}, PID ${snapshot.currentWindow.pid}, window ${snapshot.currentWindow.windowId}`;
}

function formatDuration(ms: number): string {
    return `${Math.round(ms / 1000)}s`;
}
