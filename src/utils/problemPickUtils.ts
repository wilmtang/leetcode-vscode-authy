// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IProblem, IQuickItemEx, ProblemState } from "../shared";

// Builds the quick-pick rows for the problem search/pick list. Deliberately free
// of any `vscode` runtime dependency so the label/detail formatting — which
// drives how the picker's fuzzy filter matches what the user types — can be
// unit-tested without the Extension Host. See problem-pick-label.test.ts.
export function parseProblemsToPicks(problems: IProblem[]): Array<IQuickItemEx<IProblem>> {
    return problems.map((problem: IProblem) => ({
        // The space after "${id}." is load-bearing, not cosmetic. VS Code's
        // quick-pick filter matches the typed query as a subsequence of this
        // label, so a user typing "721. Accounts Merge" (with the space, the way
        // it reads) only matches when the label carries that space too. Drop it
        // and the label becomes "721.Accounts Merge", whose only space sits
        // before "Merge" — the typed space can't align there, so the item
        // vanishes from the results.
        label: `${parseProblemDecorator(problem.state, problem.locked)}${problem.id}. ${problem.name}`,
        description: "",
        detail: `AC rate: ${problem.passRate}, Difficulty: ${problem.difficulty}`,
        value: problem,
    }));
}

export function parseProblemDecorator(state: ProblemState, locked: boolean): string {
    switch (state) {
        case ProblemState.AC:
            return "$(check) ";
        case ProblemState.NotAC:
            return "$(x) ";
        default:
            return locked ? "$(lock) " : "";
    }
}
