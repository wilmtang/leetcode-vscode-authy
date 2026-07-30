# Full Code Audit — 2026-07-30

## Executive Summary

This audit covered the VS Code extension runtime, the browser auth-sync
extension, unit and live-integration tests, packaging scripts, GitHub Actions
workflows, package metadata, and both production and development dependency
trees.

All high- and medium-severity implementation findings identified in this pass
were fixed. The offline suite increased from 53 to 64 passing tests. The final
compile, lint, offline test, Chrome package, Firefox lint/package, and VSIX
package checks pass. The production dependency audit reports zero
vulnerabilities.

This was not a claim of universal runtime proof. The local live-auth fixture had
expired, so authenticated live API behavior could not be revalidated. Interactive
VS Code webview behavior, real browser installation, multi-window listener
handoff, Windows/WSL behavior, and the already-documented `leetcode.cn` path
remain outside the executed proof.

## Findings And Disposition

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| A3-01 | High | Every webview enabled `command:` URIs and JavaScript, including panels rendering remote LeetCode problem and community-solution content. A crafted link could reach VS Code commands after a click. | Fixed. Command URIs are disabled globally. JavaScript is opt-in only for the two panels that use `postMessage`; solution and submission panels run without scripts. |
| A3-02 | High | The HTML sanitizer was regex-based. It missed browser-normalized inputs such as unquoted attributes, encoded schemes, active tags, and `command:` URLs. Some rendered remote metadata also bypassed the sanitizer, and post-sanitization math restoration was not context-aware. | Fixed. Remote HTML, rendered markdown, and metadata now pass through a parser-based tag, attribute, and scheme allow-list. Math restores only at sanitized marker elements; active/navigation-capable elements are dropped and links receive `noopener noreferrer`. Regression cases cover quoted, unquoted, encoded, command, and attribute-context inputs. |
| A3-03 | High | Authenticated Axios and curl requests followed redirects. A LeetCode redirect could forward cookies or replayed `Authorization` headers to another origin. | Fixed. Both transports stop at redirects. A local regression server verifies that the redirect destination is not contacted. Hop-by-hop and malformed replay headers are also rejected. |
| A3-04 | High | A newly synced cookie replaced the last known-good keychain value before LeetCode verified it. Account changes could also leave a new credential paired with the previous username or replay metadata, and a stale background verification could overwrite a newer session. | Fixed. Candidate credentials are verified without borrowing the previous account's browser headers. Account/session changes replace absent replay metadata instead of retaining it, and background responses are discarded when their cookie snapshot is obsolete. |
| A3-05 | Medium | Concurrent auth updates were not serialized, while the browser discarded a new update whenever another sync was in flight. This could lose the latest login or account switch. | Fixed. The loopback server and browser extension now preserve update order. Browser requests have a 45-second abort timeout, callback API failures propagate, cookie collection prefers URL-scoped cookies, and logged request metadata is bounded/sanitized. |
| A3-06 | Medium | Configured output paths and remote problem metadata could introduce traversal or path separators into generated solution paths. The WSL path converter unnecessarily invoked a shell. Cancelling a tag/company choice silently substituted an empty value. | Fixed. The resolved file must remain inside the selected workspace, remote placeholder values are reduced to one safe path segment, WSL conversion passes literal argv without a shell, and picker cancellation cancels generation. |
| A3-07 | Medium | A forced explorer refresh arriving during an older fetch was de-duplicated away. Account or endpoint changes could therefore rebuild from stale catalog data. | Fixed. One follow-up forced fetch is retained and further overlapping requests coalesce. A deterministic concurrency regression test covers the race. |
| A3-08 | Medium | Testcase normalization replaced every literal `\\n` sequence with a real newline. That corrupts JSON string inputs such as `"line1\\nline2"`. | Fixed. API/file testcases normalize physical line endings only; `\\n` decoding is restricted to the single-line input-box boundary. |
| A3-09 | Medium | VSIX packaging attempted to include the local `.env` file and log files. Current VSCE rejected the package, but an older/overridden packager could have published local data. | Fixed. Environment files, logs, and internal agent/site files are excluded. The resulting VSIX was inspected and packaged successfully. |
| A3-10 | Medium | The production dependency tree contained three high-severity advisory paths, including Axios/form-data and linkification/parser dependencies. | Fixed. Runtime and packaging dependencies were upgraded, `sanitize-html` was added at a Node-compatible exact version, and known vulnerable nested tooling leaves were overridden. `npm audit --omit=dev` reports zero vulnerabilities. |
| A3-11 | Medium | Linux, Windows, and release validation packaged the extension after compile/lint but did not run the offline regression suite. Browser JavaScript did not have even a syntax gate. | Fixed. CI and release validation run `npm test`; that command now includes syntax checks for the browser background, options, and popup scripts. |
| A3-12 | Low | Telemetry submission could wait indefinitely and events arriving during a send could remain cached with no later flush scheduled. | Fixed. The request has a ten-second timeout and a post-current-send flush is scheduled when new events arrive. |
| A3-13 | Low | Several smaller contracts were counter-intuitive or silently lossy: SecretStorage caches changed before writes completed, sign-out/state deletion was fire-and-forget, malformed cached header values were trusted, profile opening passed a string instead of a `Uri`, and `showDescription` had four enum values but two descriptions. | Fixed. Persistence is awaited before caches change, deletion is awaited, cached headers are type-filtered, profile URLs use `Uri`, and package metadata matches the actual choices. |

## Dependency Audit Detail

The locked production tree reports zero vulnerabilities:

```text
npm audit --omit=dev
found 0 vulnerabilities
```

The unrestricted npm audit still exits non-zero for 11 high-severity
development-tool chain entries. The genuinely stale `adm-zip`, `shell-quote`,
`diff`, and `serialize-javascript` leaves were overridden to patched versions.
The remaining graph is rooted in Mocha, TSLint, and web-ext/addons-linter
depending on older minimatch/brace-expansion major lines. Current upstream
versions still select those lines. They are not shipped in the VSIX and receive
only repository-controlled glob patterns in this workflow. Forcing unrelated
major versions underneath those tools was rejected because it would create an
unverified toolchain. TSLint replacement and upstream web-ext/Mocha movement
should be tracked as maintenance work.

The VSIX still contains 3,721 files (5.93 MB), primarily runtime packages.
Bundling the extension would improve installation/startup performance and reduce
the package surface, but it is a build-system change rather than a safe audit
patch.

## Verification Evidence

Executed successfully after the fixes:

```text
git diff --check
npm run compile
npm run lint
npm test                         64 passing
npm audit --omit=dev             0 vulnerabilities
npm run auth-sync:lint:firefox   0 errors, 2 compatibility warnings
npm run auth-sync:build:chrome
npm run auth-sync:build:firefox
npm run build -- --out <temporary-path>/vscode-leetcode-auth-sync.vsix
```

The Firefox warnings are the existing dual-manifest compatibility warning
(`background.service_worker` is ignored in favor of `background.scripts`) and
the Android minimum-version/data-collection-permission warning. Both browser
archives were produced successfully.

Before and after the changes, `npm run test:integration` produced 4 passing, 5
failing, and 2 skipped tests. Public catalog requests passed; authenticated
profile, cache, detail, and solution checks failed because the ignored local
fixture no longer represented a signed-in LeetCode session. Account-mutating
favorite and submit tests were not enabled. A freshly captured fixture is
required before treating live authenticated behavior as verified.

## Accepted Boundaries And Remaining Proof Gaps

- The loopback listener's optional-secret, no-`Origin` behavior remains the
  documented zero-configuration design. This audit did not make the secret
  mandatory.
- The legacy VS Code deep-link cookie flow remains available behind VS Code's
  external URI prompt.
- `leetcode.cn` remains broken/untested as already documented.
- No real Chrome/Firefox install-and-sync session or native VS Code extension
  host interaction was executed.
- Multi-window owner election, observer takeover, Windows, and WSL behavior were
  inspected but not exercised end-to-end.
- Re-capture `src/test/.secrets/leetcode-auth.local.json` and rerun the live
  integration suite before release. Enable the favorite/submit mutation flags
  only deliberately.
