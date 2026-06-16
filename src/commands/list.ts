// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { COMPANIES, TAGS } from "../data/companiesTags";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import { formatAcceptanceRate, getFavoriteProblemSlugs, ILeetCodeProblem, listProblems as listProblemsViaApi } from "../request/leetcode-api";
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

        // The problemset `isFavor` flag no longer tracks the default "Favorite"
        // list after LeetCode's favorites migration, so membership is read from
        // the list itself. Failure here is non-fatal — fall back to `isFavor`.
        const favoriteSlugs: Set<string> | undefined = await safeGetFavoriteSlugs();

        // listProblemsViaApi already returns the catalog sorted ascending by
        // frontend id, so unlike the old CLI text path there is nothing to reverse.
        return apiProblems.map((problem: ILeetCodeProblem) => toExtensionProblem(problem, favoriteSlugs));
    } catch (error) {
        await promptForOpenOutputChannel("Failed to list problems. Please open the output channel for details.", DialogType.error);
        return [];
    }
}

async function safeGetFavoriteSlugs(): Promise<Set<string> | undefined> {
    try {
        return await getFavoriteProblemSlugs();
    } catch (error) {
        // Non-fatal, but log it: `isFavor` is no longer a usable fallback, so a
        // failure here silently empties the Favorite tree. Surface it so it is
        // diagnosable from the output channel.
        leetCodeChannel.appendLine(`[favorites] Could not load the Favorite list; the Favorite tree may be empty: ${error}`);
        return undefined;
    }
}

function toExtensionProblem(problem: ILeetCodeProblem, favoriteSlugs: Set<string> | undefined): IProblem {
    const id: string = problem.questionFrontendId;
    const isFavorite: boolean = favoriteSlugs ? favoriteSlugs.has(problem.titleSlug) : problem.isFavorite;
    return {
        id,
        questionFrontendId: id,
        questionId: problem.questionId,
        titleSlug: problem.titleSlug,
        isFavorite,
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
