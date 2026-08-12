import * as assert from "assert";
import { getConfigurationTransition } from "../../configurationCoordinator";
import { ProfileRequestCoordinator } from "../../webview/profileRequestCoordinator";

describe("configuration and profile ownership", () => {
    it("maps settings to the required state transition", () => {
        assert.strictEqual(getConfigurationTransition("leetcode.endpoint"), "auth-and-catalog");
        assert.strictEqual(getConfigurationTransition("leetcode.useEndpointTranslation"), "catalog-refetch");
        assert.strictEqual(getConfigurationTransition("leetcode.hideSolved"), "tree-rebuild");
        assert.strictEqual(getConfigurationTransition("leetcode.problems.sortStrategy"), "tree-rebuild");
        assert.strictEqual(getConfigurationTransition("leetcode.colorizeProblems"), "decorations");
    });

    it("rejects old profile successes and failures after refresh or account change", () => {
        const coordinator: ProfileRequestCoordinator = new ProfileRequestCoordinator();
        const accountA = coordinator.begin(1);
        const accountB = coordinator.begin(2);
        assert.ok(!coordinator.isCurrent(accountA, 2));
        assert.ok(coordinator.isCurrent(accountB, 2));
        coordinator.invalidate();
        assert.ok(!coordinator.isCurrent(accountB, 2));
    });
});
