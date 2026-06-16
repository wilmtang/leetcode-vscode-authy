// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { COMPANIES, TAGS } from "../data/companiesTags";
import { leetCodeManager } from "../leetCodeManager";
import { formatAcceptanceRate, ILeetCodeProblem, listProblems as listProblemsViaApi } from "../request/leetcode-api";
import { IProblem, UserStatus } from "../shared";
import * as settingUtils from "../utils/settingUtils";
import { DialogType, promptForOpenOutputChannel } from "../utils/uiUtils";

export async function listProblems(): Promise<IProblem[]> {
    try {
        if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
            return [];
        }

        const useEndpointTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
        const apiProblems: ILeetCodeProblem[] = await listProblemsViaApi({
            needTranslation: useEndpointTranslation,
            showLocked: true,
        });

        // listProblemsViaApi already returns the catalog sorted ascending by
        // frontend id, so unlike the old CLI text path there is nothing to reverse.
        return apiProblems.map(toExtensionProblem);
    } catch (error) {
        await promptForOpenOutputChannel("Failed to list problems. Please open the output channel for details.", DialogType.error);
        return [];
    }
}

function toExtensionProblem(problem: ILeetCodeProblem): IProblem {
    const id: string = problem.questionFrontendId;
    return {
        id,
        questionFrontendId: id,
        questionId: problem.questionId,
        titleSlug: problem.titleSlug,
        isFavorite: problem.isFavorite,
        locked: problem.locked,
        state: problem.state,
        name: problem.title,
        difficulty: problem.difficulty,
        passRate: formatAcceptanceRate(problem.acRate),
        // LeetCode does not expose per-problem company data on the free API, so
        // companies and tags come from the vendored static snapshot to keep the
        // Company/Tag explorer trees populated. See src/data/companiesTags.ts.
        companies: COMPANIES[id] || ["Unknown"],
        tags: TAGS[id] || ["Unknown"],
    };
}
