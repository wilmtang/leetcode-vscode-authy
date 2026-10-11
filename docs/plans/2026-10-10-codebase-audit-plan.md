# Codebase Audit and Remediation Plan — 2026-10-10

## Outcome and scope

Audited `main` at `c6d7e911de834ce551bc79fa4ced0cc9586b010c`, with a clean
starting worktree. The audit found **12 confirmed finding groups: three P1 and
nine P2**. The user subsequently requested implementation ("fix them"). The
closure ledger below records **11 implemented and locally verified groups and
one partial group (A5-10)**. Two unpatched development-only advisory paths remain.

The review covered authentication/storage, the loopback listener and companion
browser extension, HTTP/GraphQL workflows, catalog/explorer state, solution files,
judge commands, webview rendering, telemetry, packaging, tests, and CI. The prior
2026-08-11 closure ledger was checked against current source. Its helper-level
tests pass, but several claimed invariants do not hold across composed workflows.

P1 means resolve before release because account/credential integrity or the
required production dependency gate is affected. P2 means a reproducible
correctness, availability, or user-facing contract defect. All findings below are
described against the baseline above; current disposition is in the closure ledger.

## Confirmed findings

### A5-01 — P1: SecretStorage hydration can undo sign-out in memory or lose a remote update

`persistAuthSession` does not invalidate an already-running hydration. A read
started with account A can finish after a local sign-out write, replace the
signed-out cache with A, and emit a reconciliation event that restores the
displayed signed-in state. Independently, every secret-change event received
while a local store is pending is dropped, including a sibling window's later
write. The local completion then installs its obsolete snapshot without rereading
the final keychain record. Atomic serialization of the record does not solve
either ordering defect.

Evidence: `src/globalState.ts` (lines 85–92, 241–269);
`src/leetCodeManager.ts` (lines 294–309). The offline probe reproduced both
signed-in cache versus durable signed-out record, and local-account cache versus
remote-account durable record. Native multi-window event timing remains untested.

Fix boundary: give local writes and remote reads one cache ownership generation;
retain a dirty notification during writes and reconcile the actual durable record
afterward. Treat removal/invalid records as an explicit invalidation too.
Acceptance: stall hydration, sign out, resolve the old read; then interleave a
remote write with local persistence. Cache, manager identity, and keychain must
converge without resurrecting stale credentials. Preserve failure-safe migration.

### A5-02 — P2: Catalog state survives account changes and accepts invalidated results

The `statusChanged` listener only rerenders the tree. It neither invalidates the
catalog nor loads data for the new account. A→sign-out→B therefore reuses A's
solved/favorite data in the explorer and Search. Separately, `invalidate()` clears
the cache but does not invalidate the in-flight loader; its old success can
repopulate the cleared cache, including after an endpoint/translation change.
Soft refreshes then reuse that obsolete result.

Evidence: `src/extension.ts` (lines 44–48, 64–71, 87–90);
`src/explorer/explorerNodeManager.ts` (lines 27–49, 61–89).
The activation probe retained A's catalog after sign-out and B's login; a deferred
loader probe repopulated data after explicit invalidation.

Fix boundary: key catalog ownership by account session and endpoint/configuration
generation; invalidate on transitions, discard old completions, and refresh a
visible explorer while retaining lazy loading for a hidden one.
Acceptance: warmed A→B, sign-out during load, and endpoint change during load must
never display A's account data under B or repopulate an invalidated generation.
Keep last-known-good data only within the same owner.

### A5-03 — P1: Favorite mutation combines one account's list with another account's credentials

`mutateFavorite` resolves the default list using the current cookie, awaits that
lookup, then reads the cookie and replay headers again for the mutation. Rotation
from A to B during the lookup sends A's `favoriteSlug` with B's credentials. There
is no account revision check, cancellation, or post-response ownership check;
the command can also update whichever catalog happens to be current.

Evidence: `src/request/leetcode-api.ts` (lines 812–837, 902–932);
`src/request/leetcode-http.ts` (lines 464–475);
`src/commands/star.ts` (lines 30–46). The mock transport observed account A for
lookup and account B for mutation carrying `list-a`. **A successful wrong-account
server mutation was not demonstrated**; real LeetCode may reject the stale list.
The mixed-account outbound mutation itself is confirmed.

Fix boundary: pass one immutable session/endpoint snapshot through list lookup
and mutation; abort on ownership loss before sending and before changing cache.
Acceptance: rotate or sign out during lookup, mutation, and completion. No
request may mix accounts, and an obsolete completion must not alter B's tree.

### A5-04 — P2: Local auth transitions leave an open profile stale or permanently loading

Profile invalidation/reloading is wired only to remote SecretStorage events.
Local persistence deliberately suppresses those events, and local `statusChanged`
does not touch the panel. Sign-out leaves the old profile visible; browser A→B
sync updates only the Session Sync card, allowing B's sync identity beside A's
profile. Local same-account writes also increment the revision: pending sections
then fail the ownership check and are silently discarded without replacement.

Evidence: `src/globalState.ts` (lines 85–92, 241–255);
`src/extension.ts` (lines 44–71); `src/commands/profile.ts` (lines 39–68);
`src/auth/authSyncServer.ts` (lines 512–524). The activation probe kept an open
A profile after local sign-out and B sign-in.

Fix boundary: route local and remote auth transitions through one notification
contract that refreshes or clears the panel and owns pending sections. Avoid
leaving skeletons stranded on credential-only revisions.
Acceptance: local sign-out, manual/browser A→B, and same-user header rotation
while sections load must produce a coherent panel and a terminal section state.

### A5-05 — P2: Judge cancellation and account ownership stop at only some stages

Test/Submit fetch judge metadata without their cancellation callback. Even an
already-cancelled operation sends that request; cancelling a stalled metadata
request cannot abort Axios/curl. After enqueue, result polling checks only user
cancellation/newer judge-operation IDs, not the initiating auth revision. Signing
out or changing account can therefore continue polling with old credentials and
return/render the prior account's result.

Evidence: `src/request/leetcode-http.ts` (lines 148–177, 184–198);
`src/request/submit-solution.ts` (lines 25–50, 65–77);
`src/request/test-solution.ts` (lines 42–80);
`src/commands/submit.ts` (lines 24–34). The Axios-adapter probe observed a metadata
request with no cancel token for an already-cancelled submission, and returned
A's Accepted result after rotating the stored session to B during polling.

Fix boundary: compose cancellation with session/endpoint ownership once and pass
it to every stage, including metadata, retries, polls, and final presentation.
Acceptance: cancel/rotate at each stage; transport aborts promptly, no further
request is sent, and no obsolete result panel appears. Distinguish deliberate
cancellation from a failure notification.

### A5-06 — P2: Auth-sync's 35-second budget is reused for each transport

The server calculates a deadline and checks it after validation, but
`fetchUserStatus` only passes a numeric timeout. Axios may consume most of that
timeout; Cloudflare fallback then gives curl the same full timeout again. Client
disconnect and server deadline are not propagated to either transport. The final
guard prevents a normal late commit, but does not bound validation/queue occupancy
to 35 seconds. An expired queued request also returns without ending its response.

Evidence: `src/auth/authSyncServer.ts` (lines 466–477, 512–527);
`src/leetCodeManager.ts` (lines 151–165);
`src/request/leetcode-api.ts` (lines 376–406);
`src/request/leetcode-http.ts` (lines 224–252, 278–285, 324–341).
With mocked transports, a 25 ms Axios phase and 35 ms curl phase completed in
63 ms despite a 50 ms validation budget. The normal browser timeout is 45 seconds.

Fix boundary: carry an absolute deadline plus cancellation through queue and
transport boundaries; give fallback only the remaining time, and end/reject every
expired live response. Recheck ownership/expiry immediately before persistence.
Acceptance: slow challenge→fallback, disconnect, and queue expiry terminate within
one total budget and release queue/socket work, without a late auth commit.

### A5-07 — P2: GraphQL fallback still converts malformed catalog data into success

REST's container is validated, but GraphQL's absent `problemsetQuestionList` or
`questions` defaults to `[]`. REST failure followed by HTTP-200 `{data:{}}` is
reported as a successful empty catalog and replaces last-known-good state.
The reported-total pagination branch also lacks the duplicate/forward-progress
validation added to the no-total branch: repeated pages are deduplicated into a
silently incomplete result.

Evidence: `src/request/leetcode-api.ts` (lines 282–294, 1176–1213, 1270–1277,
1312–1319); `src/explorer/explorerNodeManager.ts` (lines 77–87). The probe returned
successful `[]` for malformed REST and missing GraphQL list containers. The
reported-total duplicate path is source-confirmed, not live-service reproduced.

Fix boundary: validate list/page/total shapes, distinguish genuine emptiness from
missing data, and require progress/completeness in both pagination branches.
Acceptance: malformed, missing, repeated, truncated, and genuine-empty fixtures;
failure retains the current owner's prior catalog and exposes Retry.

### A5-08 — P2: A pending developer capture can restore secrets after Developer mode is disabled

`captureDevPayloadNow` reads `devMode`, then awaits cookie lookup before writing.
`saveSettings` and `clearDevPayload` run independently. Disabling Developer mode
can save `false`, clear the credential payload, and acknowledge success; the old
capture then stores the cookie back in browser local storage. Automatic captures
also use settings captured before their asynchronous work.

Evidence: `browser-extension/background.js` (lines 51–64, 172–176, 515–560,
688–713); `browser-extension/options.js` (lines 36–48). The VM probe stalled cookie
lookup, disabled mode and verified clearing, then resumed capture: `devMode=false`
coexisted with a newly persisted synthetic credential payload.

Fix boundary: serialize capture/settings/clear commits or use a capture generation
with a final mode check inside the write boundary. Make disable+clear one storage
transaction where possible.
Acceptance: stall both manual and automatic capture across disable/clear; no
pre-transition capture may repopulate cleared credentials after acknowledgement.
Explicit capture while Developer mode is enabled remains supported.

### A5-09 — P2: The browser treats malformed HTTP-200 responses as successful sync

Failed JSON parsing becomes `{}`. Only explicit `data.ok === false` is rejected,
so an unrelated local service's HTML page, empty response, or missing `ok` field
can produce “Synced” and start the 30-minute cooldown without VS Code storing a
session. This defeats the server's otherwise actionable port-conflict UX.

Evidence: `browser-extension/background.js` (lines 210–255). The VM returned a
200 HTML page and observed `ok:true` plus a new `lastSyncAt`.

Fix boundary: require the expected JSON object and explicit `ok:true` before
recording success; add protocol/service identity if extending the server response.
Acceptance: non-JSON, empty, null, array, missing/false `ok`, and valid success
fixtures. Invalid responses preserve the last successful cooldown timestamp.

### A5-10 — P1: Production dependency gate regressed; the tooling exception expired

Fresh registry audits report **seven production vulnerability nodes** (four high,
two moderate, one low), and **27 total nodes** (three critical, 18 high, five
moderate, one low). Counts are affected package nodes, not distinct advisories or
demonstrated exploits. The prior five-node tooling exception expired 2026-09-30
and does not cover today's graph. CI/release validation never runs either npm
audit command, so the documented production gate is not enforced.

| Production package | Locked version | npm severity |
| --- | --- | --- |
| axios | 1.19.0 | High |
| katex | 0.16.47 | Low |
| markdown-it | 14.3.0 | Moderate |
| nanoid | 3.3.17 | High |
| postcss | 8.5.25 | High, through affected dependencies |
| sanitize-html | 2.17.5 | Moderate |
| source-map-js | 1.2.1 | High |

The markdown issue is reachable: the extension enables `linkify:true` and renders
remote article content synchronously in the extension host. Synthetic 35 KB and
70 KB soft-broken email paragraphs took about 0.10 s and 0.43 s in the current
renderer, showing roughly quadratic growth. The upstream advisory identifies
14.3.1 as patched. Larger workloads were not run during this audit.
[markdown-it upstream advisory](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-253c-mchw-3w2r).

Other advisory exploitability is not established here. For example, the Axios
redirect advisory concerns its fetch adapter; this extension's default Node HTTP
adapter passed the redirect test. The strict sanitizer excludes SVG/textarea
tags, which reduces the cited sanitizer attack surfaces. Do not equate npm's
severity labels with demonstrated application exploits.
[Axios upstream advisory](https://github.com/axios/axios/security/advisories/GHSA-r4gj-5m52-g5wh).

Evidence: `package.json` (lines 804–818), `package-lock.json`;
`src/webview/markdownEngine.ts` (lines 130–133);
`src/webview/leetCodeSolutionProvider.ts` (lines 77–81);
`.github/workflows/build.yml`, `.github/workflows/vscode-extension.yml`;
fresh `npm audit` and `npm audit --omit=dev` registry responses.

Fix boundary: review compatible patched runtime resolutions, remove obsolete
overrides, then separately update tooling or document narrow current exceptions.
Enforce the production audit in CI/release validation. Do not blindly force npm
upgrades: declared VS Code `^1.57.0` and bundled `node14` target need compatibility
evidence or an explicit supported-host change.
Acceptance: both audit scopes recorded, production audit exit zero, sanitizer and
bounded markdown regressions pass, package checks pass, and declared minimum-host
behavior is verified. Any tooling acceptance names exact paths and expiry.

### A5-11 — P2: Nonce-only webview style CSP blocks KaTeX layout styles

KaTeX returns inline `style` attributes for fraction/radical positioning. The
renderer restores that generated markup after sanitization, but Preview and
Solution CSPs allow only stylesheets and nonce-bearing style elements. A nonce
does not authorize a span's style attribute. Therefore mathematical layout loses
required positioning even when the external KaTeX stylesheet loads.

Evidence: `src/webview/textRenderer.ts` (lines 32–36, 120–127);
`src/webview/leetCodePreviewProvider.ts` (line 108);
`src/webview/leetCodeSolutionProvider.ts` (line 57). A Firefox page with actual
renderer output for a fraction plus square root and the same style CSP generated
21 `style-src-attr` violations, matching its 21 generated inline styles. This
confirms the browser policy conflict; native VS Code rendering is still untested.

Fix boundary: allow only the trusted generated math styles through a deliberate
rendering/CSP contract (for example, generated stylesheet rules). Preserve the
sanitizer boundary for remote markup and the nonce restriction on style elements.
Acceptance: fraction, radical, superscript, and matrix visual fixtures in a real
webview; zero math style violations and unchanged adversarial markup protection.

### A5-12 — P2: Generated MySQL solution markers are not recognized

The generator uses `-- @lc code=start/end` for MySQL, while `isMarkerLine` accepts
only bare, `//`, `#`, or `/*` markers. `extractSolutionCode` thus falls back to
submitting the entire file. SQL outside the intended solution block is sent to
the judge, potentially changing execution or causing otherwise valid solutions
to fail. The existing generation tests exercise C++ and Python, not MySQL.

Evidence: `src/utils/codeTemplateUtils.ts` (lines 19–24);
`src/utils/solutionFileGenerator.ts` (lines 50–55);
`src/utils/solutionDocument.ts` (lines 14–17, 26–35). A generated MySQL fixture with
an extra SQL statement after the end marker returned the whole file as code.

Fix boundary: align recognized comment markers with the generator's supported
languages while preserving strict marker matching and legacy markerless files.
Acceptance: round-trip every supported comment style; MySQL extracts only the
marked body, and decoy/early-end marker regressions remain green.

## Suggested independent implementation commits

| Order | Coherent change | Findings |
| --- | --- | --- |
| 1 | SecretStorage read/write ownership and adversarial event-order tests | A5-01 |
| 2 | Shared local/remote auth notifications and profile transitions | A5-04 |
| 3 | Catalog account/endpoint generations and invalidation tests | A5-02 |
| 4 | Immutable favorite workflow and cache completion guards | A5-03 |
| 5 | End-to-end judge cancellation/session ownership | A5-05 |
| 6 | Absolute auth-sync transport/queue deadlines | A5-06 |
| 7 | GraphQL schema and pagination validation | A5-07 |
| 8 | Browser capture/settings/clear ownership | A5-08 |
| 9 | Strict browser sync response validation | A5-09 |
| 10 | Compatible runtime dependency remediation and CI gate | A5-10 |
| 11 | Separate tooling advisory remediation/current policy | A5-10 |
| 12 | Trusted math styles with browser visual/CSP regressions | A5-11 |
| 13 | MySQL marker parsing and generator round-trips | A5-12 |

Implementation was authorized by the subsequent "fix them" request. Related
request changes share one commit because they use the same immutable workflow
owner and HTTP cancellation/deadline contract. Actual commits are listed below.

## Verification and reproduction evidence

Environment: macOS, Node `v26.11.1`. Checks were run against the unchanged runtime
tree; no live LeetCode credentials, favorite changes, or submissions were used.

| Check | Observed result |
| --- | --- |
| `npm run compile` | Pass |
| `npm run lint` | Pass |
| `npm test` | 89 passing, browser persistence/syntax checks pass, package content contract passes |
| Package contract | 80 prospective extension files; 2.24 MiB bundle; no packaged `node_modules` |
| First restricted test run | 86 passing, three `listen EPERM` sandbox failures; full rerun with local socket access passed |
| `npm audit --omit=dev --json` | Registry returned seven affected production package nodes; not a clean gate |
| `npm audit --json` | Registry returned 27 affected package nodes, including three critical tooling nodes |
| Offline audit harness | All asserted interleavings/contracts reproduced; markdown timings are diagnostic measurements |
| Firefox math CSP probe | 21 generated inline styles, 21 `style-src-attr` violations |

The initial registry request failed under restricted networking; it was rerun
with network access. Audit JSON was captured before printing summaries; the shell
summary command's exit status is not a passing npm audit result.

The initial probes were converted into the permanent
[offline regression harness](../../scripts/test-audit-regressions.cjs), using
synthetic credentials, memory storage, VM browser APIs, and mocked Axios/curl
transports. It exercises compiled production modules and activation hooks. Run
the current regressions after compiling:

```bash
npm run compile
npm run test:audit
```

The original observations above establish baseline violations; the current
harness asserts the corrected contracts. Neither proves actual keychain
cross-process timing, native panel behavior, or current live API authorization.
The separate CSP check used the real math renderer in a browser page with the
provider's policy; it was not a native Extension Host test.

## Prior-audit disposition and intentional boundaries

- A4-01/A4-02's local intent coordinator and atomic record remain useful; A5-01
  concerns hydration versus writes, and A5-03 concerns an unconverted favorite
  workflow. Passing coordinator tests do not close these composed races.
- A4-03's same-owner failure retention and force-refresh coalescing remain;
  A5-02 covers missing owner invalidation, A5-07 covers the GraphQL boundary.
- A4-05's section generation guard remains; A5-04 covers missing transition
  notifications, which also strand legitimately rejected callbacks.
- A4-06/A4-09's shutdown bound and cancellable judge enqueue/poll transports
  remain; A5-05/A5-06 cover missing metadata/session/deadline propagation.
- A4-10's storage-failure acknowledgement remains; A5-08 covers successful writes
  racing cleanup. Developer-mode capture at rest is intentional while enabled.
- A4-13 was clean at its recorded verification time; A5-10 is current registry
  drift and expired policy, not a claim that the old result was fabricated.
- A4-14's style nonce hardening remains; A5-11 is its conflict with trusted math
  markup. A4-11's marker ordering fix remains; A5-12 is unsupported SQL syntax.
- No-secret/no-Origin loopback POST and cookie-bearing URI sign-in remain
  intentional. No mandatory-secret change or removal of the legacy flow is
  proposed. `leetcode.cn` remains documented broken/untested; its known-only gaps
  are not relisted as new defects. Credentials must remain in SecretStorage.

## Remaining proof gaps

Native VS Code minimum/current hosts, real sibling-window/keychain races, live
LeetCode and Cloudflare behavior, Windows junction/UNC paths, Remote WSL,
installed Chrome/Firefox failure scenarios, and keyboard/screen-reader/high-
contrast/zoom verification were not executed. No remote CI run, store publication,
or release was performed. Baseline success alone does not close a finding.

## Implementation closure ledger

Local verification completed 2026-10-10. "Implemented" means the source change
and offline/browser checks passed; it does not imply native/live proof.

| Finding | Current disposition | Implementation and evidence |
| --- | --- | --- |
| A5-01 | Implemented; native sibling-window proof open | Serialized writes invalidate stale reads, assign revisions at the write boundary, reconcile the durable winner, and notify removal/invalid records. Unreadable current records fail closed and suspend auto-sync; stale read errors cannot invalidate a newer session. Deferred-read/store, migration failure, local notification, remote removal, queued revision and read-failure regressions pass. |
| A5-02 | Implemented; native explorer proof open | Catalogs have auth/endpoint ownership and invalidation generations; old completions cannot replace new data. Visible views refresh on transitions; hidden views remain lazy. Catalog and favorite reads share captured credentials. |
| A5-03 | Implemented; live favorite authorization proof open | Favorite lookup, pages, mutation, and cache application retain one auth/endpoint owner. Tests rotate during lookup and mutation and reject obsolete completion. No live account was mutated. |
| A5-04 | Implemented; native panel proof open | Local and remote durable transitions share notifications. Sign-out clears the open profile; account/header rotation replaces section generations. Composed activation checks verify four replacement sections complete and stale sections cannot overwrite them. |
| A5-05 | Implemented; live judge proof open | Metadata, enqueue/retry, actual/expected polling, and final presentation use composed user cancellation and auth/endpoint ownership. 21 stalled-stage interleavings abort transport and issue no next-stage request. Already-cancelled work sends no metadata request; obsolete Accepted results are rejected. Deliberate cancellation stays quiet; request timeouts remain errors. |
| A5-06 | Implemented; native keychain and live transport proof open | One absolute budget spans body/queue/validation and Axios/curl fallback. Curl receives fractional remaining seconds. Disconnect/server generation cancels validation; expired queued responses end with 504. Guards are rechecked at both manager and serialized storage boundaries before starting persistence. The 50 ms mock budget terminates at about 53 ms; queued expiry and disconnect probes pass. |
| A5-07 | Implemented; live schema drift proof open | Missing/invalid page shapes and totals, duplicate pages, and incomplete reported totals fail. Genuine empty and complete 150-question fixtures pass; same-owner failure retention remains tested. |
| A5-08 | Implemented; installed-browser proof open | Settings/clear/capture writes are serialized. Disable and cleanup use one storage write; captures check generation and current mode at commit. Manual and sync-path captures stalled across disable/clear cannot restore credentials. Successful capture acknowledgement matches stored payload/timestamp. |
| A5-09 | Implemented; installed-browser proof open | Only a non-array JSON object with explicit `ok:true` starts successful cooldown. HTML, empty, null, arrays, absent/false/string `ok` fail without updating the successful timestamp. |
| A5-10 | **Partial; two upstream tooling advisories open** | All production and critical tooling findings removed; production audit is enforced in CI and the VSCE prepublish lifecycle. Updated bundle passes Node 14 smoke through a scoped `Object.hasOwn` adapter. Full audit still exits 1 with seven development-only nodes on the two paths detailed below. No exception was silently renewed. |
| A5-11 | Implemented; native webview proof open | Trusted restored math styles become private selector rules in a nonced stylesheet; remote styles/selectors are stripped. Firefox displayed fraction, radical, superscript, and matrix with 38 rules, zero inline styles and zero CSP violations. Fonts were embedded for this browser fixture; native resource loading remains untested. |
| A5-12 | Implemented | Exact `--` marker recognition aligns with generation. Round-trips cover all 17 supported languages, legacy markerless SQL, and end-before-start/outside-body statements. |

### Dependency disposition

Resolved runtime versions: Axios 1.20.0, KaTeX 0.19.0, markdown-it 14.3.2,
sanitize-html 2.18.0, nanoid 3.3.18, PostCSS 8.5.29, source-map-js 1.2.2.
Developer tools include VSCE 4.0.0, Open VSX 1.2.0 (sharing VSCE 4), web-ext
10.7.0, adm-zip 0.6.1 and shell-quote 1.12.0, plus compatible major-scoped
brace-expansion/js-yaml and qs patches. The full audit is **not clean**:

| Unresolved path | Registry evidence and boundary |
| --- | --- |
| `web-ext` → `@devicefarmer/adbkit` → `node-forge@1.4.0` | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), RSA signature verification. Registry latest is 1.4.0 and affected. The offered web-ext 5.1 downgrade is a major tooling regression, not a reviewed fix. Absent from the packaged extension/browser runtime. |
| `tslint` → `js-yaml@3.15.2` → `argparse@1.0.10` → `sprintf-js@1.0.3` | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), unbounded precision denial of service. Registry latest sprintf-js 1.1.3 is also affected. A major argparse substitution breaks js-yaml's CLI API. Remove through the planned lint migration or a reviewed upstream patch; absent from runtime. |

These seven affected nodes (three high, four moderate) represent two underlying
advisories and their propagated parents. `npm run audit:all` continues to fail;
this ledger does not approve a new development-only exception. Recheck before
release; either remove the paths or make a separate explicit maintainer policy
decision. Production audit remains mandatory and cannot be waived by this residue.

sanitize-html's Node 22 package requirement includes its ESM parser loading and
modern `Object.hasOwn` use. Development installation runs on Node 22.12+; the shipped
bundle inlines the parser, transforms ESM and substitutes a local compatibility
function without modifying host globals. A real Node 14.21.3 process loaded the
packaged extension and exercised sanitized HTML, math, markdown, and soft-broken
email input. The declared VS Code minimum remains unchanged; this is runtime
smoke evidence, not a native VS Code 1.57 activation test. CI adds this smoke after
building with Node 22.
The Open VSX CLI's optional prompt-library Node type peers are scoped to the
existing project Node 14 type declaration dependency. The precompiled CLI still
runs on Node 22.12+; this project does not compile/consume its TypeScript SDK.
This prevents tool type peers from replacing the extension-host type contract
and does not override any runtime Node engine requirement.

### Actual focused commits

- `8cd62ca` — auth storage read/write reconciliation.
- `3ff807e` — profile/catalog transitions and invalidation generations.
- `d2e94f3` — immutable authenticated workflows, schema checks, cancellation and deadlines.
- `f1425b7` — browser capture cleanup and strict response validation.
- `8dafc99` — MySQL marker recognition and language round-trips.
- `673ad81` — trusted math stylesheet/CSP contract.
- `74b3a95` — serialized auth revision assignment.
- `cd8c643` — patched dependencies, audited packaging/CI, and permanent composed regressions.
- `989712a` — unreadable current keychain records fail closed; stale failures are ignored.
- `83d0426` — indentation correction within the auth transaction introduced by this task.
- `0d5e038` — optional CLI type peers retain the extension-host declarations; clean install verified.

### Final local verification

| Check | Result |
| --- | --- |
| Compile / lint | Both passed |
| `npm test` | 98 unit tests, composed audit regressions (including 21 judge interleavings), browser persistence/syntax and package contract passed |
| Clean install / dependency tree | `npm ci --ignore-scripts` and `npm ls --all --json` exit 0; no invalid/missing dependency problems |
| Production audit | Exit 0; zero affected nodes |
| Full audit | Exit 1; seven development-only nodes, zero critical; unresolved paths above |
| Bundled Node 14 smoke | Actual Node 14.21.3 passed; current Node 26.11.1 also passed |
| VSIX packaging | `/private/tmp/authy-audit-fixed.vsix`, 82 archive entries, 1.36 MB; 80 extension files and 2.26 MiB runtime bundle |
| Firefox lint/build | Exit 0, zero errors/notices, two manifest compatibility warnings (service worker ignored in Firefox; Android minimum/data-collection permission mismatch); ZIP built |
| Open VSX compatibility | CLI help loads with the shared VSCE 4 library; live publication not attempted |
| Browser math | Four rendered fixtures, fonts loaded, zero inline styles/CSP violations; screenshot inspected |
| Bounded markdown fixture | 700 KB soft-broken email input rendered in 379 ms on the final full-suite run; 3 s smoke bound passed |
| Whitespace/source links | `git diff --check` and local link validation passed |

No push, remote CI, store publication, native keychain/window/panel run, live
LeetCode request, Windows/WSL execution or manual accessibility proof was performed.
SecretStorage has no CAS or cancellable store primitive: guards can reject work
before the native store starts, but cannot abort an already-running keychain RPC.
The ledger remains indexed and active while A5-10's tooling residue is open.
