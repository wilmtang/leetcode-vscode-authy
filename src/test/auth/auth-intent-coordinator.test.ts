import * as assert from "assert";
import {
    AuthIntentCoordinator,
    IAuthIntent,
} from "../../auth/authIntentCoordinator";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise: Promise<T> = new Promise<T>((done: (value: T) => void) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("AuthIntentCoordinator", () => {
    it("prevents a stalled login from committing after sign-out", async () => {
        const coordinator: AuthIntentCoordinator = new AuthIntentCoordinator();
        const validation = deferred<string>();
        const login: IAuthIntent = coordinator.begin("manual-cookie");
        const commit = validation.promise.then(() => coordinator.assertCurrent(login));

        coordinator.begin("sign-out");
        validation.resolve("account-a");

        await assert.rejects(commit, { name: "AuthIntentSupersededError" });
    });

    it("allows only the newest overlapping login to commit", async () => {
        const coordinator: AuthIntentCoordinator = new AuthIntentCoordinator();
        const first: IAuthIntent = coordinator.begin("manual-cookie");
        const second: IAuthIntent = coordinator.begin("uri");

        assert.throws(() => coordinator.assertCurrent(first), { name: "AuthIntentSupersededError" });
        assert.doesNotThrow(() => coordinator.assertCurrent(second));
    });

    it("does not let a passive refresh steal ownership", () => {
        const coordinator: AuthIntentCoordinator = new AuthIntentCoordinator();
        const login: IAuthIntent = coordinator.begin("automatic-sync");
        const refresh: IAuthIntent = coordinator.capture("refresh");

        assert.strictEqual(refresh.revision, login.revision);
        assert.doesNotThrow(() => coordinator.assertCurrent(login));
    });
});
