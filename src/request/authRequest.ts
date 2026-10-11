import { globalState } from "../globalState";
import { getUrl } from "../shared";
import { DirectApiUnsupportedError, throwIfCancelled } from "./leetcode-http";

/** One immutable credential and endpoint owner for an awaited workflow. */
export function captureAuthRequest(cancelled?: () => boolean) {
    const auth = globalState.getAuthSession();
    if (!auth || auth.state !== "signed-in" || !auth.cookie) {
        throw new DirectApiUnsupportedError("No synced LeetCode cookie is available.");
    }
    const base = getUrl("base");
    const graphql = getUrl("graphql");
    const isCancelled = () => !!(cancelled && cancelled()) || !globalState.isAuthRevisionCurrent(auth.revision) || base !== getUrl("base");
    return {
        auth, cookie: auth.cookie, base, graphql, isCancelled,
        overrides: { browserUserAgent: auth.browserUserAgent, browserRequestHeaders: auth.browserRequestHeaders },
        assertCurrent: () => throwIfCancelled(isCancelled),
    };
}

export type AuthRequest = ReturnType<typeof captureAuthRequest>;
