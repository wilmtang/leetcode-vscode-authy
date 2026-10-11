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
npm run bundle
npm test
npm run lint
npm run test:integration
```

`npm test` is offline. It compiles `tsconfig.test.json`, runs mapper,
renderer/XSS, request-security, cache-concurrency, path/testcase, and
solution-file round-trip tests, then syntax-checks the browser extension's
JavaScript entry points and verifies the prospective VSIX content contract.

The published extension runtime is `out/extension.js`, produced by esbuild with
`vscode` externalized. The build copies KaTeX's stylesheet and fonts to
`out/katex/`; those are the only third-party files kept outside the bundle.
`.vscodeignore` excludes `node_modules/` and TypeScript's per-module `out/src/`
tree. `scripts/verify-vscode-package.js` fails if either tree re-enters the
package, required KaTeX assets disappear, external npm imports remain in the
bundle, the runtime bundle exceeds 3 MiB, or the prospective package grows
beyond 150 extension files.

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

1. Open the LeetCode VS Code Authy browser extension settings and enable Developer mode.
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
npm run test:package
npm run build -- --out dist/vscode-leetcode-auth-sync.vsix
npm run auth-sync:lint:firefox
npm run auth-sync:build:firefox
npm run auth-sync:build:chrome
```

## Audit Notes

The latest review is [Codebase Audit and Remediation Plan — 2026-10-10](plans/2026-10-10-codebase-audit-plan.md),
against baseline `c6d7e91`, followed by the authorized implementation. It records
11 locally verified groups and one partial dependency group. Keychain reads and
writes share ownership; profile/catalog consumers receive local and remote
transitions; favorites/catalog/judge requests retain immutable auth/endpoint
owners; validation has one deadline; browser cleanup and reply contracts are
guarded; math uses trusted nonced rules; generated SQL markers round-trip.
Compile, lint, 96 unit tests, composed race checks (21 judge interleavings),
browser persistence checks, VSIX packaging, Node 14 bundle smoke, and Firefox
math layout/CSP verification passed. The ledger lists commits and native/live
proof gaps. No push or publication was performed.

The implemented remediation plan is
[Code, Performance, Engineering, and UX Audit Plan — 2026-08-11](plans/2026-08-11-code-performance-ux-audit-plan.md).
It records 16 source-confirmed finding groups against `30154f3`, the focused
implementation commits, local closure evidence, final verification matrix,
intentional non-changes, and environment-dependent release proof gaps.

The 2026-08-11 remediation intended the following invariants. The latest ledger
above records the composed regressions and repaired boundaries; the bundle
measurements here are historical verification results:

- authentication is a generation-owned, single-record SecretStorage snapshot;
  explicit sign-out is durable and browser sync cannot silently undo it;
- catalog/profile/configuration work retains last-known-good state and discards
  stale generations;
- auth listener, solution-file, and judge operations are bounded, physically
  contained, no-clobber, account-revision-owned, and cancellable;
- the catalog is lazy, the runtime bundle is 2.24 MiB with a 3 MiB gate, and
  production dependency audit is clean;
- webview inline styles are nonce-backed, markdown font settings are serialized
  as CSS data, and problem/profile/browser state has non-color semantics;
- public cache/status/side-mode contracts are effective and command failures use
  a credential-redacting diagnostic path.

### Unresolved development-only audit paths

`npm run audit:production` is required to exit zero and is enforced by CI and the
VSCE prepublish lifecycle. After the 2026-10-10 fixes it reports zero affected
production nodes. `npm run audit:all` still exits 1: seven development-only nodes
(three high, four moderate), on two underlying advisories below. Critical nodes
were removed. These paths are absent from the packaged runtime. They are open,
not an approved exception; the old exception expired 2026-09-30 and was not renewed.

| Path | Disposition |
| --- | --- |
| `web-ext` → `@devicefarmer/adbkit` → `node-forge@1.4.0` | RSA verification advisory GHSA-86w9-cpqp-85rv; latest registry release remains affected. Requires a reviewed upstream fix or tooling replacement. Do not silently downgrade web-ext to 5.1. |
| `tslint` → `js-yaml@3.15.2` → `argparse@1.0.10` → `sprintf-js@1.0.3` | Precision denial-of-service advisory GHSA-hp3w-g68c-fv3c; latest sprintf-js 1.1.3 remains affected. Remove through the planned lint migration or reviewed upstream fix; an incompatible argparse override is not a fix. |

A release review must rerun both scopes and either remove these paths or make
a separate explicit maintainer acceptance decision. Source-level reachability
limits do not make the full audit clean. The detailed ledger links advisories
and records tool checks; Firefox lint has two manifest compatibility warnings.

Development installation/build uses Node 22.12+. The packaged extension retains
the declared older VS Code host contract: ESM dependencies are bundled to CJS,
and Object.hasOwn is replaced by a local adapter without changing host globals.
Build the renderer smoke fixture with `npm run test:runtime:build`, then run
`node scripts/run-runtime-smoke.cjs 14` under an actual Node 14 process. CI does
this after packaging. Native minimum/current VS Code runs remain separate proof.

The previous complete remediation review is
[Full Code Audit — 2026-07-30](audits/2026-07-30-full-code-audit.md). It records
the fixed findings, exact verification, accepted boundaries, development-tool
advisory residue, and the live-auth proof gap.

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
- The VS Code runtime is bundled, with a package-content regression test
  preventing `node_modules/` or `out/src/` from re-entering the VSIX.

Still fair game in future reviews:

- Credential-at-rest handling
- Request/HTTP edge cases
- Webview CSP and sanitizer regressions
- Explorer cache invalidation
- Auth-sync concurrency and ownership handoff
- `leetcode.cn` restoration
- Migration from deprecated TSLint and unresolved node-forge/sprintf-js
  advisory resolution in the development toolchain
