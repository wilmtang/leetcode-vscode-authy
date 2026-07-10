// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Command, Uri } from "vscode";
import { IProblem, ProblemState } from "../shared";

export class LeetCodeNode {

    constructor(private data: IProblem, private isProblemNode: boolean = true) { }

    public get locked(): boolean {
        return this.data.locked;
    }
    public get name(): string {
        return this.data.name;
    }

    public get state(): ProblemState {
        return this.data.state;
    }

    public get id(): string {
        return this.data.id;
    }

    public get questionFrontendId(): string {
        return this.data.questionFrontendId || this.data.id;
    }

    public get questionId(): string | undefined {
        return this.data.questionId;
    }

    public get titleSlug(): string | undefined {
        return this.data.titleSlug;
    }

    public get passRate(): string {
        return this.data.passRate;
    }

    public get difficulty(): string {
        return this.data.difficulty;
    }

    public get tags(): string[] {
        return this.data.tags;
    }

    public get companies(): string[] {
        return this.data.companies;
    }

    public get isFavorite(): boolean {
        return this.data.isFavorite;
    }

    public get isProblem(): boolean {
        return this.isProblemNode;
    }

    public get previewCommand(): Command {
        return {
            title: "Preview Problem",
            command: "leetcode.previewProblem",
            arguments: [this],
        };
    }

    public get acceptanceRate(): number {
        return Number(this.passRate.slice(0, -1).trim());
    }

    public get uri(): Uri {
        return Uri.from({
            scheme: "leetcode",
            authority: this.isProblem ? "problems" : "tree-node",
            path: `/${this.id}`, // path must begin with slash /
            query: `difficulty=${this.difficulty}`,
        });
    }

}
