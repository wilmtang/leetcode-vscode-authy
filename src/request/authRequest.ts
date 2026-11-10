import { globalState, IAuthSessionSnapshot } from "../globalState";
import { getUrl } from "../shared";
import { DirectApiUnsupportedError, throwIfCancelled } from "./leetcode-http";

export interface ICaptureAuthOptions {
    /**
     * Keep the workflow alive across same-account credential refreshes (a browser
     * sync of fresh cf_clearance / replayed headers bumps the auth revision).
     * Sign-out, a different account, or an endpoint switch still cancel it.
     * Used by judge workflows, whose already-enqueued results must not be dropped.
     */
    sameAccount?: boolean;
}

/** True while the current session is signed in as the same account as `auth`. */
export function isSameAccountCurrent(auth: IAuthSessionSnapshot): boolean {
    const current: IAuthSessionSnapshot | undefined = globalState.getAuthSession();
    return !!current && current.state === "signed-in" && !!current.cookie
        && !!current.identity && !!auth.identity
        && current.identity.username === auth.identity.username;
}

/** One immutable credential and endpoint owner for an awaited workflow. */
export function captureAuthRequest(cancelled?: () => boolean, options: ICaptureAuthOptions = {}) {
    const auth = globalState.getAuthSession();
    if (!auth || auth.state !== "signed-in" || !auth.cookie) {
        throw new DirectApiUnsupportedError("No synced LeetCode cookie is available.");
    }
    const base = getUrl("base");
    const graphql = getUrl("graphql");
    const authCurrent = options.sameAccount
        ? () => isSameAccountCurrent(auth)
        : () => globalState.isAuthRevisionCurrent(auth.revision);
    const isCancelled = () => !!(cancelled && cancelled()) || !authCurrent() || base !== getUrl("base");
    return {
        auth, cookie: auth.cookie, base, graphql, isCancelled,
        overrides: { browserUserAgent: auth.browserUserAgent, browserRequestHeaders: auth.browserRequestHeaders },
        assertCurrent: () => throwIfCancelled(isCancelled),
    };
}

export type AuthRequest = ReturnType<typeof captureAuthRequest>;
