import * as assert from "assert";
import { classifySolutionDocument, extractSolutionCode } from "../../utils/solutionDocument";
import { JudgeOperationCoordinator } from "../../commands/judgeOperationCoordinator";

describe("solution document ownership", () => {
    it("ignores an end marker before the matching start marker", () => {
        const content: string = [
            "// @lc app=leetcode id=1 lang=typescript",
            "// @lc code=end",
            "// @lc code=start",
            "const marker = '@lc code=end';",
            "return marker;",
            "// @lc code=end",
        ].join("\n");
        const classification = classifySolutionDocument(content);
        assert.strictEqual(classification.startLine, 2);
        assert.strictEqual(classification.endLine, 5);
        assert.strictEqual(extractSolutionCode(content), "const marker = '@lc code=end';\nreturn marker;");
    });

    it("lets only the newest judge operation render", () => {
        const coordinator: JudgeOperationCoordinator = new JudgeOperationCoordinator();
        const testId: number = coordinator.begin();
        const submitId: number = coordinator.begin();
        assert.ok(!coordinator.isCurrent(testId));
        assert.ok(coordinator.isCurrent(submitId));
    });
});
