import * as assert from "assert";
import {
    formatAcceptanceRate,
    mapCnProblem,
    mapGlobalProblem,
    mapQuestionDetail,
    mapSession,
} from "../../request/leetcode-api";
import { ProblemState } from "../../shared";
import {
    cnQuestionItem,
    cnQuestionItemPercentPassThrough,
    globalQuestionItem,
    globalQuestionItemLockedUnknown,
    questionDetailItem,
    sessionItem,
    sessionItemAnonymousEmpty,
} from "../fixtures/leetcode-responses";

describe("leetcode-api mappers", () => {
    describe("mapGlobalProblem", () => {
        it("maps a solved, free problem with slug-based tags", () => {
            const problem = mapGlobalProblem(globalQuestionItem);
            assert.strictEqual(problem.questionFrontendId, "1");
            assert.strictEqual(problem.questionId, "1");
            assert.strictEqual(problem.titleSlug, "two-sum");
            assert.strictEqual(problem.title, "Two Sum");
            assert.strictEqual(problem.difficulty, "Easy");
            assert.strictEqual(problem.acRate, 49.1);
            assert.strictEqual(problem.locked, false);
            assert.strictEqual(problem.isFavorite, false);
            assert.strictEqual(problem.state, ProblemState.AC);
            assert.deepStrictEqual(problem.tags, ["array", "hash-table"]);
            assert.deepStrictEqual(problem.companies, []);
        });

        it("normalizes unknown status / uppercase difficulty and marks paidOnly as locked", () => {
            const problem = mapGlobalProblem(globalQuestionItemLockedUnknown);
            assert.strictEqual(problem.difficulty, "Hard");
            assert.strictEqual(problem.locked, true);
            assert.strictEqual(problem.isFavorite, true);
            assert.strictEqual(problem.state, ProblemState.Unknown);
            assert.deepStrictEqual(problem.tags, []);
        });
    });

    describe("mapCnProblem", () => {
        it("uses translated title/tags and scales a fractional acRate when translating", () => {
            const problem = mapCnProblem(cnQuestionItem, true);
            assert.strictEqual(problem.title, "两数相加");
            assert.deepStrictEqual(problem.tags, ["链表"]);
            assert.strictEqual(problem.acRate, 50);
            assert.strictEqual(problem.state, ProblemState.NotAC);
            assert.strictEqual(problem.isFavorite, true);
            assert.strictEqual(problem.titleSlug, "add-two-numbers");
        });

        it("uses the English title and slug tags when not translating", () => {
            const problem = mapCnProblem(cnQuestionItem, false);
            assert.strictEqual(problem.title, "Add Two Numbers");
            assert.deepStrictEqual(problem.tags, ["linked-list"]);
        });

        it("passes through an already-percentage acRate (> 1)", () => {
            const problem = mapCnProblem(cnQuestionItemPercentPassThrough, true);
            assert.strictEqual(problem.acRate, 73);
        });
    });

    describe("mapQuestionDetail", () => {
        it("prefers translated content and tags when translating", () => {
            const detail = mapQuestionDetail(questionDetailItem, true);
            assert.strictEqual(detail.content, "<p>中文题面</p>");
            assert.deepStrictEqual(detail.topicTags, ["数组"]);
            assert.strictEqual(detail.questionId, "1");
            assert.strictEqual(detail.titleSlug, "two-sum");
            assert.strictEqual(detail.codeSnippets.length, 2);
            assert.deepStrictEqual(detail.exampleTestcaseList, ["[2,7,11,15]\n9"]);
        });

        it("falls back to English content and slug tags when not translating", () => {
            const detail = mapQuestionDetail(questionDetailItem, false);
            assert.strictEqual(detail.content, "<p>English content</p>");
            assert.deepStrictEqual(detail.topicTags, ["array"]);
        });
    });

    describe("mapSession", () => {
        it("computes acceptance rates and coerces the id to a string", () => {
            const session = mapSession(sessionItem);
            assert.strictEqual(session.id, "123");
            assert.strictEqual(session.name, "Primary");
            assert.strictEqual(session.active, true);
            assert.strictEqual(session.acQuestions, 10);
            assert.strictEqual(session.submittedQuestions, 20);
            assert.strictEqual(session.questionAcceptanceRate, 50);
            assert.strictEqual(session.submissionAcceptanceRate, 50);
        });

        it("defaults id/name and avoids division by zero", () => {
            const session = mapSession(sessionItemAnonymousEmpty);
            assert.strictEqual(session.id, "");
            assert.strictEqual(session.name, "Anonymous Session");
            assert.strictEqual(session.active, false);
            assert.strictEqual(session.questionAcceptanceRate, 0);
            assert.strictEqual(session.submissionAcceptanceRate, 0);
        });
    });

    describe("formatAcceptanceRate", () => {
        it("formats with two decimals and a percent suffix", () => {
            assert.strictEqual(formatAcceptanceRate(49.1), "49.10 %");
        });
    });
});
