// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { leetCodeManager } from "../leetCodeManager";
import { Category, defaultProblem, ProblemState } from "../shared";
import { explorerNodeManager } from "./explorerNodeManager";
import { LeetCodeNode } from "./LeetCodeNode";
import { globalState } from "../globalState";

export class LeetCodeTreeDataProvider implements vscode.TreeDataProvider<LeetCodeNode> {
    private context: vscode.ExtensionContext;

    private onDidChangeTreeDataEvent: vscode.EventEmitter<LeetCodeNode | undefined | null> = new vscode.EventEmitter<
        LeetCodeNode | undefined | null
    >();
    // tslint:disable-next-line:member-ordering
    public readonly onDidChangeTreeData: vscode.Event<any> = this.onDidChangeTreeDataEvent.event;

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    // `force` re-fetches the catalog; a soft refresh (force = false) re-renders
    // from the cached catalog — used for client-side-only changes like sorting
    // and star toggles.
    public async refresh(force: boolean = true): Promise<void> {
        await explorerNodeManager.refreshCache(force);
        this.onDidChangeTreeDataEvent.fire(null);
    }

    public getTreeItem(element: LeetCodeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (element.id === "notSignIn") {
            return {
                label: element.name,
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                command: {
                    command: "leetcode.signin",
                    title: "Sign in to LeetCode",
                },
            };
        }
        if (element.id === "catalogError") {
            return {
                label: element.name,
                tooltip: "The last refresh failed. The last known catalog is still shown.",
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                command: { command: "leetcode.refreshExplorer", title: "Retry problem catalog" },
            };
        }

        let contextValue: string;
        if (element.isProblem) {
            contextValue = element.isFavorite ? "problem-favorite" : "problem";
        } else {
            contextValue = element.id.toLowerCase();
        }

        return {
            label: element.isProblem ? `[${element.id}] ${element.name}` + this.parsePremiumUnLockIconPath(element) : element.name,
            tooltip: this.getSubCategoryTooltip(element),
            collapsibleState: element.isProblem ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
            iconPath: this.parseIconPathFromProblemState(element),
            command: element.isProblem ? element.previewCommand : undefined,
            resourceUri: element.uri,
            contextValue,
        };
    }

    public getChildren(element?: LeetCodeNode | undefined): vscode.ProviderResult<LeetCodeNode[]> {
        if (!leetCodeManager.getUser()) {
            return [
                new LeetCodeNode(
                    Object.assign({}, defaultProblem, {
                        id: "notSignIn",
                        name: "Sign in to LeetCode",
                    }),
                    false
                ),
            ];
        }
        if (!element) {
            // Root view
            const roots: LeetCodeNode[] = explorerNodeManager.getRootNodes();
            if (explorerNodeManager.getCatalogError()) {
                roots.unshift(new LeetCodeNode(Object.assign({}, defaultProblem, {
                    id: "catalogError",
                    name: "Catalog refresh failed — Retry",
                }), false));
            }
            return roots;
        } else {
            switch (element.id) {
                case Category.All:
                    return explorerNodeManager.getAllNodes();
                case Category.Favorite:
                    return explorerNodeManager.getFavoriteNodes();
                case Category.Difficulty:
                    return explorerNodeManager.getAllDifficultyNodes();
                case Category.Tag:
                    return explorerNodeManager.getAllTagNodes();
                case Category.Company:
                    return explorerNodeManager.getAllCompanyNodes();
                default:
                    if (element.isProblem) {
                        return [];
                    }
                    return explorerNodeManager.getChildrenNodesById(element.id);
            }
        }
    }

    private parseIconPathFromProblemState(element: LeetCodeNode): string {
        if (!element.isProblem) {
            return "";
        }
        const { isPremium } = globalState.getUserStatus() ?? {};
        switch (element.state) {
            case ProblemState.AC:
                return this.context.asAbsolutePath(path.join("resources", "check.png"));
            case ProblemState.NotAC:
                return this.context.asAbsolutePath(path.join("resources", "x.png"));
            case ProblemState.Unknown:
                if (element.locked && !isPremium) {
                    return this.context.asAbsolutePath(path.join("resources", "lock.png"));
                }
                return this.context.asAbsolutePath(path.join("resources", "blank.png"));
            default:
                return "";
        }
    }

    private parsePremiumUnLockIconPath(element: LeetCodeNode): string {
        const { isPremium } = globalState.getUserStatus() ?? {};
        if (isPremium && element.locked) {
            return "  🔓";
        }
        return "";
    }

    private getSubCategoryTooltip(element: LeetCodeNode): string {
        // return '' unless it is a sub-category node
        if (element.isProblem || element.id === "ROOT" || element.id in Category) {
            return "";
        }

        const childernNodes: LeetCodeNode[] = explorerNodeManager.getChildrenNodesById(element.id);

        let acceptedNum: number = 0;
        let failedNum: number = 0;
        for (const node of childernNodes) {
            switch (node.state) {
                case ProblemState.AC:
                    acceptedNum++;
                    break;
                case ProblemState.NotAC:
                    failedNum++;
                    break;
                default:
                    break;
            }
        }

        return [`AC: ${acceptedNum}`, `Failed: ${failedNum}`, `Total: ${childernNodes.length}`].join(os.EOL);
    }
}

export const leetCodeTreeDataProvider: LeetCodeTreeDataProvider = new LeetCodeTreeDataProvider();
