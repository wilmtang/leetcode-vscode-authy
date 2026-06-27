# Maintainer Guide

This is the one repo-local guide for implementation notes, live testing, known
caveats, and publishing. User-facing usage stays in [README.md](../README.md).

## Current State

| Area | Current source | Notes |
| --- | --- | --- |
| Problem list | `src/request/leetcode-api.ts`, `src/commands/list.ts` | Uses the fast REST catalog when possible, with GraphQL fallback. The Favorite tree is populated from the default Favorite list, not from `isFavor`. |
| Problem description and files | `src/commands/show.ts`, `src/utils/solutionFileGenerator.ts`, `src/webview/textRenderer.ts` | `getQuestionDetail` fetches detail once and reuses it for file generation plus preview. Descriptions and solutions render KaTeX. |
| Test and submit | `src/request/leetcode-http.ts`, `src/request/test-solution.ts`, `src/request/submit-solution.ts` | Uses lean judge metadata, CSRF-aware direct requests, timeout handling, and curl fallback when Cloudflare challenges node/axios. |
| Sign-in | `src/leetCodeManager.ts`, `src/auth/authSyncServer.ts`, `src/globalState.ts` | Browser auth sync is the preferred path. Session cookies and captured browser headers live in `context.secrets`, not Memento. |
| Favorites | `src/request/leetcode-api.ts`, `src/commands/star.ts` | Uses `addQuestionToFavoriteV2` and `removeQuestionFromFavoriteV2` with `favoriteSlug` plus `questionSlug`. Verified by the opt-in live favorite test. |
| Solutions | `src/request/leetcode-api.ts`, `src/commands/show.ts` | Fetches the most-voted overall community solution via `ugcArticleSolutionArticles` and article content by topic id. |
| Profile panel | `src/statusbar/LeetCodeStatusBarItem.ts`, `src/commands/profile.ts`, `src/webview/leetCodeProfileProvider.ts` | Clicking the signed-in status bar item opens a profile webview. Sections fetch independently so one failed profile query does not blank the whole panel. |
| Old CLI | Removed | `vsc-leetcode-cli` is no longer the runtime path for list/detail/auth/favorites/solutions/test/submit. |

## Current Caveats

- `leetcode.com` is the validated endpoint.
- `leetcode.cn` support is inherited but currently broken/untested for at least Favorites and Solutions. Favorites still look for a default list named `Favorite`; `.cn` uses localized naming. Solutions use a different community API.
- The auth-sync listener is loopback-only. It intentionally accepts no-`Origin` POSTs without a secret so local zero-config sync works. Set `leetcode.authSync.secret` if local processes are not trusted.
- The legacy `vscode://...?...cookie=...` Web Authorization flow intentionally ingests a cookie from the VS Code deep link after VS Code's external URI prompt.
- The live integration suite can mutate the account only when explicitly opted in with `LEETCODE_LIVE_FAVORITE=1` or `LEETCODE_LIVE_SUBMIT=1`.

## Build And Test

```bash
npm run compile
npm test
npm run lint
npm run test:integration
```

`npm test` is offline. It compiles `tsconfig.test.json` and runs mapper,
renderer/XSS, and solution-file round-trip tests.

`npm run test:integration` hits the live LeetCode API only when a local auth
fixture exists. Without one, the live suite self-skips.

## Live Integration Tests

The live fixture path is:

```text
src/test/.secrets/leetcode-auth.local.json
```

That file is gitignored. The committed
`src/test/.secrets/leetcode-auth.local.example.json` is only a zero-byte
placeholder so the directory exists.

Capture the fixture:

1. Open the LeetCode Auth Sync browser extension settings and enable Developer mode.
2. Sign in to `leetcode.com`, then refresh a LeetCode page so the extension captures browser headers.
3. Open the extension popup, choose Developer, then Copy test fixture.
4. Paste the copied JSON into `src/test/.secrets/leetcode-auth.local.json`.
5. Put the real cookie in that file's `"cookie"` field. Never put real cookies in the committed example file.

Expected shape:

```json
{
  "endpoint": "leetcode",
  "cookie": "LEETCODE_SESSION=...; csrftoken=...",
  "userAgent": "Mozilla/5.0 ...",
  "requestHeaders": { "accept": "*/*" }
}
```

Run the normal live suite:

```bash
npm run test:integration
```

Run account-mutating checks only on purpose:

```bash
LEETCODE_LIVE_FAVORITE=1 npm run test:integration -- --grep "favorites"
LEETCODE_LIVE_SUBMIT=1 npm run test:integration -- --grep "judge submit"
```

The favorite test restores the original `two-sum` favorite state in a `finally`
block. The submit test records a real submission on the account.

Secret guards:

- `.gitignore` ignores `src/test/.secrets/*` and `*.local.json`, except the empty placeholder.
- `npm run local -- hooks` enables the repo pre-commit hook.
- The hook blocks staged `.local.json`, staged non-placeholder `.secrets/` files, and staged content containing `LEETCODE_SESSION=`.

## Local Auth Sync Testing

Start the VS Code extension host:

```bash
npm run local -- vscode:dev
```

Start Chrome with the unpacked browser extension:

```bash
npm run local -- chrome:dev
```

Use the current Chrome profile only when you really need existing login state:

```bash
npm run local -- chrome:dev-current
```

Manual Firefox path:

1. Open `about:debugging#/runtime/this-firefox`.
2. Load the `browser-extension/` directory as a temporary add-on.
3. Reload it after changes to `background.js`, `manifest.json`, popup/options files, or icons.

Smoke-test the listener:

```bash
curl -i http://127.0.0.1:17899/health
```

Useful commands:

```text
LeetCode: Show Browser Auth Sync Status
LeetCode: Restart Browser Auth Sync Server
LeetCode: Force Start Browser Auth Sync Server
```

If `leetcode.authSync.secret` is set in VS Code, set the same shared secret in
the browser extension. Cookie-only sync is useful for quick login refreshes, but
it does not capture Cloudflare/browser request headers. For the best test/submit
coverage, click Expire now and refresh a real LeetCode page.

## Request And Cloudflare Notes

The direct API request layer starts with node/axios and a fixed timeout. If the
response is a Cloudflare challenge, including a 200 HTML challenge page, it
replays the request through `curl`.

Sensitive values are passed to curl through a `-K -` config on stdin. The cookie,
authorization headers, and request body do not appear in argv.

When debugging live failures, inspect the LeetCode output channel. It logs the
request mode and whether the failure came from node/axios, curl, LeetCode auth,
Cloudflare, non-JSON output, or an unexpected status.

## Publishing

VS Code extension release:

```bash
npm run release:vscode:local
git tag vscode-extension-v0.18.8
git push origin vscode-extension-v0.18.8
```

`.github/workflows/vscode-extension.yml` verifies the tag matches
`package.json`, packages the VSIX, publishes when the tag starts with
`vscode-extension-v`, and creates a GitHub Release with generated notes, store
links, and the VSIX attached. Required environment secrets:

- `VSCE_PAT` in `vscode-marketplace`
- `OVSX_PAT` for Open VSX publishing

Browser extension release:

```bash
git tag browser-extension-v0.1.3
git push origin browser-extension-v0.1.3
```

Firefox uses `.github/workflows/firefox-extension.yml` and needs:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Chrome uses `.github/workflows/chrome-extension.yml` and needs:

- `CHROME_WEBSTORE_CLIENT_ID`
- `CHROME_WEBSTORE_CLIENT_SECRET`
- `CHROME_WEBSTORE_REFRESH_TOKEN`
- `CHROME_WEBSTORE_PUBLISHER_ID`
- `CHROME_WEBSTORE_EXTENSION_ID`

Local packaging helpers:

```bash
npm run auth-sync:lint:firefox
npm run auth-sync:build:firefox
npm run auth-sync:build:chrome
```

## Audit Notes

Do not re-report these as new findings unless the underlying design changes:

- Auth sync's no-secret local POST behavior is an accepted zero-config tradeoff; the optional shared secret is the stronger local boundary.
- The Web Authorization deep link intentionally accepts a cookie after VS Code's URI prompt.
- `fetchUserProfile` is aggregate test support. New UI callers should use the per-section profile fetchers.

Previously fixed or accepted areas:

- Catalog fetches are cached for star, sort, search, and startup flows.
- Favorite pagination is bounded by total count and a hard page cap.
- Preview and solution webviews have CSP/sanitizer hardening.
- Inline math rendering avoids common currency false positives.
- Question-detail fetches are reused when opening a problem with a webview description.
- HTTP requests have timeouts and Cloudflare challenge fallback.
- Favorite fetch failures log to the LeetCode output channel instead of silently emptying the tree.
- Missing language snippets warn without blocking file generation.
- The status bar click opens the profile panel when signed in.
- Profile panel state is preserved across markdown configuration changes.

Still fair game in future reviews:

- Credential-at-rest handling
- Request/HTTP edge cases
- Webview CSP and sanitizer regressions
- Explorer cache invalidation
- Auth-sync concurrency and ownership handoff
- `leetcode.cn` restoration
