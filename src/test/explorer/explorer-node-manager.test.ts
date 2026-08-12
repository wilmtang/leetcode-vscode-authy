import * as assert from "assert";
import { ExplorerNodeManager } from "../../explorer/explorerNodeManager";
import { CatalogLoadResult } from "../../commands/list";
import { defaultProblem, IProblem, ProblemState } from "../../shared";

function problem(id: string): IProblem {
    return {
        ...defaultProblem,
        id,
        questionFrontendId: id,
        titleSlug: `problem-${id}`,
        name: `Problem ${id}`,
        difficulty: "Easy",
        passRate: "50.00 %",
        state: ProblemState.Unknown,
    };
}

describe("ExplorerNodeManager refresh concurrency", () => {
    it("does not lose a forced refresh that arrives during an older fetch", async () => {
        const resolvers: Array<(problems: IProblem[]) => void> = [];
        const manager: ExplorerNodeManager = new ExplorerNodeManager(() => new Promise<CatalogLoadResult>((resolve) => {
            resolvers.push((problems: IProblem[]) => resolve({ kind: "success", problems }));
        }));

        const first: Promise<void> = manager.refreshCache(true);
        assert.strictEqual(resolvers.length, 1);
        const second: Promise<void> = manager.refreshCache(true);

        resolvers[0]([problem("1")]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(resolvers.length, 2, "forced refresh should schedule one follow-up fetch");
        resolvers[1]([problem("2")]);
        await Promise.all([first, second]);

        assert.strictEqual(manager.getNodeById("1"), undefined);
        assert.ok(manager.getNodeById("2"));
        manager.dispose();
    });

    it("retains last-known-good problems when a forced refresh fails", async () => {
        const results: CatalogLoadResult[] = [
            { kind: "success", problems: [problem("1")] },
            { kind: "failure", error: new Error("offline") },
        ];
        const manager: ExplorerNodeManager = new ExplorerNodeManager(async () => results.shift()!);

        await manager.refreshCache(true);
        await manager.refreshCache(true);

        assert.ok(manager.getNodeById("1"));
        assert.strictEqual(manager.getCatalogError()!.message, "offline");
        manager.dispose();
    });
});
