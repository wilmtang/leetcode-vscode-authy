// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import startCase = require("lodash/startCase");
import { Disposable } from "vscode";
import * as list from "../commands/list";
import { getSortingStrategy } from "../commands/plugin";
import { Category, defaultProblem, IProblem, ProblemState, SortingStrategy } from "../shared";
import { shouldHideSolvedProblem } from "../utils/settingUtils";
import { LeetCodeNode } from "./LeetCodeNode";
import { globalState } from "../globalState";
import { getUrl } from "../shared";

export class ExplorerNodeManager implements Disposable {
    private explorerNodeMap: Map<string, LeetCodeNode> = new Map<string, LeetCodeNode>();
    private companySet: Set<string> = new Set<string>();
    private tagSet: Set<string> = new Set<string>();
    // The fetched catalog is cached so routine re-renders (sort changes, star
    // toggles) rebuild the trees locally instead of re-fetching ~3,000 problems.
    private cachedProblems: IProblem[] | undefined;
    private fetchInFlight: Promise<void> | undefined;
    private refetchAfterCurrent: boolean = false;
    private catalogError: Error | undefined;
    private generation: number = 0;
    private owner: string | undefined;

    public constructor(private readonly problemLoader: () => Promise<list.CatalogLoadResult> = list.listProblems) { }

    // `force` re-fetches the catalog from the API; otherwise the trees are
    // rebuilt from the cached catalog (or fetched once if the cache is empty).
    public async refreshCache(force: boolean = true): Promise<void> {
        const owner = this.currentOwner();
        if (this.owner !== owner) {
            this.invalidate();
            this.owner = owner;
        }
        if (force || !this.cachedProblems) {
            await this.fetchProblems(force);
        }
        this.rebuild();
    }

    // The cached catalog for callers that need the full problem list (search,
    // pick-one) without triggering their own ~20s re-fetch. Fetches once if the
    // cache is cold; subsequent calls are instant and reuse any in-flight fetch.
    public async getProblems(): Promise<IProblem[]> {
        await this.refreshCache(false /* use cache when present */);
        return this.cachedProblems ? this.cachedProblems.slice() : [];
    }

    public getCatalogError(): Error | undefined {
        return this.catalogError;
    }

    public invalidate(): void {
        ++this.generation;
        this.fetchInFlight = undefined;
        this.refetchAfterCurrent = false;
        this.cachedProblems = undefined;
        this.catalogError = undefined;
        this.rebuild();
    }

    // Locally reflect a favorite toggle so the star path can soft-refresh without
    // re-fetching the whole catalog. Overwritten on the next forced refresh.
    public setProblemFavorite(problemId: string, isFavorite: boolean): void {
        const problem: IProblem | undefined = this.cachedProblems && this.cachedProblems.find((p: IProblem) => p.id === problemId);
        if (problem) {
            problem.isFavorite = isFavorite;
        }
    }

    private async fetchProblems(force: boolean): Promise<void> {
        // De-duplicate overlapping work, but do not lose a *forced* refresh that
        // arrives while an older account/endpoint fetch is in flight. The owner
        // drains one additional fetch after the current one; further force
        // requests coalesce into that pending pass.
        if (this.fetchInFlight) {
            if (force) {
                this.refetchAfterCurrent = true;
            }
            await this.fetchInFlight;
            return;
        }

        const generation = this.generation;
        const owner = this.currentOwner();
        const operation: Promise<void> = (async (): Promise<void> => {
            do {
                this.refetchAfterCurrent = false;
                const result: list.CatalogLoadResult = await this.problemLoader();
                if (generation !== this.generation || owner !== this.currentOwner()) {
                    return;
                }
                if (result.kind === "success") {
                    this.cachedProblems = result.problems;
                    this.catalogError = undefined;
                } else if (result.kind === "signed-out") {
                    this.cachedProblems = undefined;
                    this.catalogError = undefined;
                } else {
                    // Retain the last known-good catalog. A failed refresh is not
                    // evidence that the user's catalog is authentically empty.
                    this.catalogError = result.error;
                }
            } while (this.refetchAfterCurrent);
        })();
        this.fetchInFlight = operation;
        try {
            await operation;
        } finally {
            if (this.fetchInFlight === operation) {
                this.fetchInFlight = undefined;
            }
        }
    }

    private currentOwner(): string {
        const snapshot = globalState.getAuthSession();
        return `${snapshot && snapshot.revision}|${getUrl("base")}`;
    }

    private rebuild(): void {
        this.explorerNodeMap.clear();
        this.companySet.clear();
        this.tagSet.clear();
        const shouldHideSolved: boolean = shouldHideSolvedProblem();
        for (const problem of this.cachedProblems || []) {
            if (shouldHideSolved && problem.state === ProblemState.AC) {
                continue;
            }
            this.explorerNodeMap.set(problem.id, new LeetCodeNode(problem));
            for (const company of problem.companies) {
                this.companySet.add(company);
            }
            for (const tag of problem.tags) {
                this.tagSet.add(tag);
            }
        }
    }

    public getRootNodes(): LeetCodeNode[] {
        return [
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.All,
                name: Category.All,
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Difficulty,
                name: Category.Difficulty,
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Tag,
                name: Category.Tag,
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Company,
                name: Category.Company,
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Favorite,
                name: Category.Favorite,
            }), false),
        ];
    }

    public getAllNodes(): LeetCodeNode[] {
        return this.applySortingStrategy(
            Array.from(this.explorerNodeMap.values()),
        );
    }

    public getAllDifficultyNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        res.push(
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Easy`,
                name: "Easy",
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Medium`,
                name: "Medium",
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Hard`,
                name: "Hard",
            }), false),
        );
        this.sortSubCategoryNodes(res, Category.Difficulty);
        return res;
    }

    public getAllCompanyNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const company of this.companySet.values()) {
            res.push(new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Company}.${company}`,
                name: startCase(company),
            }), false));
        }
        this.sortSubCategoryNodes(res, Category.Company);
        return res;
    }

    public getAllTagNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const tag of this.tagSet.values()) {
            res.push(new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Tag}.${tag}`,
                name: startCase(tag),
            }), false));
        }
        this.sortSubCategoryNodes(res, Category.Tag);
        return res;
    }

    public getNodeById(id: string): LeetCodeNode | undefined {
        return this.explorerNodeMap.get(id);
    }

    public getFavoriteNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const node of this.explorerNodeMap.values()) {
            if (node.isFavorite) {
                res.push(node);
            }
        }
        return this.applySortingStrategy(res);
    }

    public getChildrenNodesById(id: string): LeetCodeNode[] {
        // The sub-category node's id is named as {Category.SubName}
        const metaInfo: string[] = id.split(".");
        const res: LeetCodeNode[] = [];
        for (const node of this.explorerNodeMap.values()) {
            switch (metaInfo[0]) {
                case Category.Company:
                    if (node.companies.indexOf(metaInfo[1]) >= 0) {
                        res.push(node);
                    }
                    break;
                case Category.Difficulty:
                    if (node.difficulty === metaInfo[1]) {
                        res.push(node);
                    }
                    break;
                case Category.Tag:
                    if (node.tags.indexOf(metaInfo[1]) >= 0) {
                        res.push(node);
                    }
                    break;
                default:
                    break;
            }
        }
        return this.applySortingStrategy(res);
    }

    public dispose(): void {
        this.invalidate();
        this.explorerNodeMap.clear();
        this.companySet.clear();
        this.tagSet.clear();
        this.cachedProblems = undefined;
        this.refetchAfterCurrent = false;
    }

    private sortSubCategoryNodes(subCategoryNodes: LeetCodeNode[], category: Category): void {
        switch (category) {
            case Category.Difficulty:
                subCategoryNodes.sort((a: LeetCodeNode, b: LeetCodeNode): number => {
                    function getValue(input: LeetCodeNode): number {
                        switch (input.name.toLowerCase()) {
                            case "easy":
                                return 1;
                            case "medium":
                                return 2;
                            case "hard":
                                return 3;
                            default:
                                return Number.MAX_SAFE_INTEGER;
                        }
                    }
                    return getValue(a) - getValue(b);
                });
                break;
            case Category.Tag:
            case Category.Company:
                subCategoryNodes.sort((a: LeetCodeNode, b: LeetCodeNode): number => {
                    if (a.name === "Unknown") {
                        return 1;
                    } else if (b.name === "Unknown") {
                        return -1;
                    } else {
                        return Number(a.name > b.name) - Number(a.name < b.name);
                    }
                });
                break;
            default:
                break;
        }
    }

    private applySortingStrategy(nodes: LeetCodeNode[]): LeetCodeNode[] {
        const strategy: SortingStrategy = getSortingStrategy();
        switch (strategy) {
            case SortingStrategy.AcceptanceRateAsc: return nodes.sort((x: LeetCodeNode, y: LeetCodeNode) => Number(x.acceptanceRate) - Number(y.acceptanceRate));
            case SortingStrategy.AcceptanceRateDesc: return nodes.sort((x: LeetCodeNode, y: LeetCodeNode) => Number(y.acceptanceRate) - Number(x.acceptanceRate));
            default: return nodes;
        }
    }
}

export const explorerNodeManager: ExplorerNodeManager = new ExplorerNodeManager();
