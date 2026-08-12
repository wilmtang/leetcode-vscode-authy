# Code, Performance, Engineering, and UX Audit Plan — 2026-08-11

Status: implemented in source; environment-dependent release proof pending

Audit target: `main` at `30154f3` (`test: smoke-load bundled extension`)

Scope: VS Code runtime, browser auth-sync extension, offline tests, package
metadata, build/package scripts, and dependency graph

## Outcome

This source review confirmed 16 remediation groups: two P1 account-integrity
defects, thirteen P2 correctness/performance/UX issues, and one P3 contract
cleanup group. No runtime fix was made during the audit. The implementation
order below starts with authentication ownership because later test/submit,
profile, explorer, and multi-window work depends on a trustworthy account
snapshot.

The most important broken invariant is that the account displayed by VS Code
must be the account whose immutable credential snapshot a command uses. That is
not currently guaranteed during sign-out, account rotation, overlapping login,
or cross-window sync.

Implementation completed on 2026-08-11 in the focused commits recorded in the
closure ledger below. The historical findings and requested proof remain here
unchanged so future reviews can distinguish source closure from the native,
live-account, cross-window, browser-install, Windows, and accessibility checks
that still require release-candidate testing.

Priority definitions:

- **P1** — account, credential, or state-changing-operation integrity; close
  before the next release.
- **P2** — confirmed correctness, availability, performance, security-boundary,
  accessibility, or materially misleading UX defect.
- **P3** — lower-risk public-contract or diagnostic debt that should be closed
  while the affected surface is being changed.

## Verification Baseline

The following checks were run against the audit target before this plan was
written:

| Check | Result |
| --- | --- |
| `npm test` | Passed: 64 offline tests, browser JavaScript syntax checks, and package-content verification. |
| `npm run lint` | Passed. |
| `npm audit --omit=dev` | Failed: 2 production advisories (1 moderate, 1 high). |
| `npm audit` | Failed: 7 advisories (1 moderate, 6 high) across production and development dependencies. |
| `out/extension.js` | 3,964,733 bytes. Metafile inspection attributed about 1.57 MB of source input to Highlight.js, 546 KB to Lodash, and 601 KB to KaTeX. |

The prospective package check reported 80 files and remained under its existing
size/content ceiling. That package check prevents accidental file inclusion; it
does not impose an activation-time or JavaScript-bundle budget.

## Confirmed Findings

### P1 — account and credential integrity

| ID | Finding and impact | Primary evidence |
| --- | --- | --- |
| A4-01 | **Sign-out is not an authoritative auth intent.** `updateSessionFromCookie` can finish validation and restore a credential after a later explicit Sign Out. Independently, Sign Out leaves automatic browser sync enabled, so the next eligible payload signs the user back in after the UI reports success. Concurrent manual, URI, and browser logins also lack one shared generation, so an older attempt can win. | `src/leetCodeManager.ts` (lines 107–131, 225–235); `src/auth/authSyncServer.ts` (lines 131–134, 453–461); `browser-extension/background.js` (lines 615–620). |
| A4-02 | **Auth data and displayed identity are not one atomic, cross-window snapshot.** Cookie, user agent, replay headers, and user status are persisted separately. Test/submit capture only the cookie while later request steps read mutable global headers. Secret changes rehydrate per-field caches, but sibling-window `LeetCodeManager` instances are not reconciled. A window can therefore display account A while requests use all or part of account B's auth state. Rejection is source-confirmed as possible; wrong-account mutation depends on unverified server header precedence and is the worst case to test. | `src/leetCodeManager.ts` (lines 121–140); `src/globalState.ts` (lines 61–107); `src/request/leetcode-http.ts` (lines 418–430); `src/request/test-solution.ts` (lines 41–70); `src/request/submit-solution.ts` (lines 24–41); `src/extension.ts` (lines 42–54); `src/auth/authSyncServer.ts` (lines 833–852). |

### P2 — correctness, performance, and UX

| ID | Finding and impact | Primary evidence |
| --- | --- | --- |
| A4-03 | **The catalog pipeline collapses failure and schema drift into an empty catalog.** `listProblems` catches a load error and returns `[]`; the cache owner then replaces the last-known-good data. A malformed REST success without `stat_status_pairs` is also accepted as empty instead of falling back. Conversely, GraphQL fallback pagination has no hard page/progress invariant if a full page repeats. The explorer, Search, and Pick One can become empty after a transient error, or fallback can loop indefinitely. | `src/commands/list.ts` (lines 12–35); `src/explorer/explorerNodeManager.ts` (lines 50–76); `src/request/leetcode-api.ts` (lines 275–291, 1163–1195, 1221–1258). |
| A4-04 | **Direct configuration edits bypass required state transitions.** The central listener handles only auth-sync settings. Editing endpoint, translation, hide-solved, sort, or colorization in Settings can leave stale credentials, catalog contents, ordering, or decorations. The already-known-broken `.cn` endpoint is also presented as a normal destructive switch with no caveat even though the recommended browser sync supports only `leetcode.com`. | `src/extension.ts` (lines 116–125); `src/commands/plugin.ts` (lines 11–49); `package.json` (lines 316–320, 401–415); `browser-extension/manifest.json` (lines 11–14). |
| A4-05 | **Profile updates have no account or request-generation ownership.** Refresh starts another four-request batch; sign-out/account switch does not close or reload the panel; auth sync updates only the Session Sync card. Late account-A responses can overwrite account-B sections or mix current sync identity with stale profile data. | `src/commands/profile.ts` (lines 24–56); `src/webview/leetCodeProfileProvider.ts` (lines 63–108, 295–336); `src/extension.ts` (lines 42–54). |
| A4-06 | **The auth-sync server lacks one bounded lifecycle.** A partial request has no body deadline or aborted/close handling, while `stop()` waits indefinitely for `server.close()`. The browser abandons a request after 45 seconds, but server verification can spend roughly 30 seconds in Axios and another 30 in curl, then commit after the browser reports failure. A failure persisting initial owner state after bind also leaves a listener that was not transactionally rolled back. | `src/auth/authSyncServer.ts` (lines 168–191, 272–310, 425–462, 497–537, 855–863); `src/request/leetcode-http.ts` (lines 215–245, 264–374); `browser-extension/background.js` (lines 23, 187–225). A raw-socket probe confirmed `server.close()` stayed pending until the incomplete client socket was destroyed. |
| A4-07 | **Solution-file generation does not uphold its path/no-clobber contract.** Containment is lexical, so a child symlink or Windows junction can redirect the write outside the selected root. The existence check precedes a network fetch and is followed by unconditional create/write, allowing an intervening file to be overwritten or a partial file to remain. An existing custom filename is opened without verifying that its embedded problem metadata matches the selected problem. Finally, `leetcode.useWsl` converts native Windows paths to `/mnt/...` even though direct Node file APIs—not a WSL CLI—consume them. | `src/utils/workspaceUtils.ts` (lines 13–87); `src/commands/show.ts` (lines 207–311); `src/request/leetcode-http.ts` (lines 104–105). |
| A4-08 | **Auto Cookie Sync cancellation and waiting state are misleading and write-heavy.** Dismissing first-run setup falls through to Continue; user cancellation and timeout both produce the same warning. During the two-minute wait, a signed-out poll runs every two seconds and repeatedly performs unconditional Memento/SecretStorage cleanup, up to about 60 rounds without any state change. | `src/leetCodeManager.ts` (lines 40–104, 246–310, 344–405); `src/globalState.ts` (lines 158–185). |
| A4-09 | **Test and Submit lack operation ownership, cancellation, and truthful presentation.** Test reports “Submitting,” both flows write into one panel titled Submission, and concurrent completions can overwrite each other. Judge polling can run 60 rounds; neither progress UI propagates cancellation through polling, HTTP, curl, or sleeps. | `src/commands/test.ts` (lines 15–22, 25–99); `src/commands/submit.ts` (lines 12–38); `src/webview/leetCodeSubmissionProvider.ts` (lines 15–25); `src/request/leetcode-http.ts` (lines 193–208). |
| A4-10 | **Browser settings and sensitive cleanup can falsely report success.** Options checkbox handlers discard `{ok:false}` and then show success. Disabling Developer mode can claim the captured credential payload was cleared when save/storage failed; the popup's Clear action also ignores its result. | `browser-extension/options.js` (lines 18–35, 55–71); `browser-extension/popup.js` (lines 99–103); `browser-extension/background.js` (lines 51–64). |
| A4-11 | **Solution-document discovery is global, inconsistent, and partly incorrect.** LeetCode editor actions appear for every editor and Test/Submit for every non-folder. Test silently returns while signed out. CodeLens is registered for every file and reads the full document. The parser chooses the first `@lc code=end` anywhere instead of the matching marker after the start marker, so a decoy can truncate or invalidate submitted code. | `package.json` (lines 270–303); `src/commands/test.ts` (lines 25–33); `src/codelens/CodeLensController.ts` (lines 15–22); `src/codelens/CustomCodeLensProvider.ts` (lines 21–45); `src/request/leetcode-http.ts` (lines 139–147). |
| A4-12 | **Activation performs avoidable network and parse work.** `onStartupFinished` is needed for the listener, but cached sign-in emits `statusChanged`, which force-fetches the entire process-local catalog even if the explorer never opens. Static root imports also load whole Highlight.js and Lodash distributions into the startup bundle. | `package.json` (lines 28–46); `src/extension.ts` (lines 42–45, 130); `src/leetCodeManager.ts` (lines 40–48); `src/webview/markdownEngine.ts` (line 4); `src/commands/show.ts` (line 5); `src/explorer/explorerNodeManager.ts` (line 4). |
| A4-13 | **The production dependency gate has regressed.** The lockfile selects `sanitize-html@2.16.0` and `nanoid@3.3.16`, producing two production advisories. The sanitizer advisory's affected attributes are excluded by the current strict allow-list, so this audit does not claim a demonstrated exploit. `sanitize-html@2.17.6` requires Node 22.12 and is incompatible with the declared VS Code 1.57-era host; remediation needs an explicitly compatible version and regression proof. | `package.json`; `package-lock.json`; `src/webview/textRenderer.ts` (lines 20–26, 72–101); current `npm audit --omit=dev` and `npm ls` output. |
| A4-14 | **Webview style configuration crosses an unescaped HTML/CSS boundary, and one CSP contradicts the advertised feature.** `markdown.preview.fontFamily` is interpolated directly inside a `<style>` element. A workspace value containing `</style>` can leave that context; preview CSP permits HTTPS images, making external loads/UI spoofing possible when the panel opens. The Submission CSP, by contrast, blocks the inline settings style and inline body style that the provider emits, while the UI says markdown appearance settings apply. | `src/webview/markdownEngine.ts` (lines 81–90); `src/webview/leetCodePreviewProvider.ts` (lines 103–112); `src/webview/leetCodeSubmissionProvider.ts` (lines 28–55); `src/webview/LeetCodeWebview.ts` (lines 75–81). |
| A4-15 | **Core state and profile/browser UI do not meet their accessibility contract.** Explorer solved/failed/locked state is icon-only. Profile loading lacks busy/live semantics, animated skeletons ignore reduced motion, and data tables lack headers/captions. Measured foreground/background pairs include browser primary buttons at 3.49:1 in light mode and 2.94:1 in dark mode, and profile difficulty labels at 2.50:1, 1.75:1, and 3.52:1 against white—below AA for normal text. | `src/explorer/LeetCodeTreeDataProvider.ts` (lines 53–60, 100–125); `src/webview/leetCodeProfileProvider.ts` (lines 167–176, 201–239, 267–278, 535–561); `browser-extension/styles.css` (lines 20–23, 49–52, 228–236). |

### P3 — public and diagnostic contract cleanup

| ID | Finding and impact | Primary evidence |
| --- | --- | --- |
| A4-16 | **Several public controls and diagnostics do not do what their copy promises.** Delete Cache is a no-op despite a real in-memory cache; `enableSideMode=false` is ignored by the Submission panel; the signed-out status item has empty text and is difficult to discover; and several errors ask users to open the output channel without first logging the caught exception. | `src/commands/cache.ts` (lines 4–8); `src/explorer/explorerNodeManager.ts` (lines 16–39); `src/webview/leetCodeSubmissionProvider.ts` (lines 21–25); `src/statusbar/LeetCodeStatusBarItem.ts` (lines 21–33); `src/commands/list.ts` (lines 32–35); `src/commands/star.ts` (lines 13–26); `src/commands/submit.ts` (lines 23–35). |

## Closure Deltas From the 2026-07-30 Audit

These findings do not simply reopen the prior closure ledger:

| Prior item | What remains closed | New, narrower defect |
| --- | --- | --- |
| A3-04 | Candidate cookies are validated before replacing the prior credential, and stale background validation checks its cookie snapshot. | A4-01/A4-02 cover auth intents outside that check, multi-field commit atomicity, immutable workflow snapshots, and cross-window identity convergence. |
| A3-05 | Browser updates and server POSTs preserve order within their own queues. | A4-01/A4-06 cover coordination with manual/URI/sign-out intents and the composed browser/server deadline. |
| A3-06 | Path templates are lexically contained and remote path segments are sanitized. | A4-07 covers physical symlink/junction containment, exclusive writes, collision identity, and the now-obsolete WSL conversion at direct file-I/O boundaries. |
| A3-07 | A forced refresh arriving during an in-flight fetch gets one follow-up fetch. | A4-03 covers failed/malformed refresh semantics and pagination forward progress, not force coalescing. |
| A3-10 | The locked production graph was clean when that audit completed. | A4-13 records the current lockfile's newly failing gate and runtime-compatibility constraint. |

## Remediation Plan

### Phase 1 — Make authentication one owned transaction

Closes A4-01 and A4-02. Do this first; Phases 2–5 consume the resulting account
revision and request snapshot.

1. Introduce one `AuthSessionSnapshot` containing a revision, state
   (`signed-in` or intentional `signed-out`), cookie, browser user agent,
   replay headers, and validated identity.
2. Persist the sensitive snapshot as one versioned SecretStorage record rather
   than several independently visible fields. Migrate the existing secret keys
   without ever moving secrets into Memento.
3. Route browser, manual-cookie, URI, refresh, and sign-out operations through
   one auth coordinator. Every awaited result must carry the initiating revision
   and lose ownership if a newer intent exists.
4. Make explicit Sign Out durable across reload and automatic sync until the
   user explicitly chooses a sign-in action. Return an actionable rejected/suspended
   response to the browser instead of silently accepting and undoing sign-out.
5. Reconcile every window from the changed snapshot before redrawing the status
   bar, tree, profile, or enabling state-changing commands. The first observed
   remote snapshot must not be skipped.
6. Capture one immutable auth snapshot for every test/submit/favorite workflow.
   Abort before mutation if its account revision is no longer current.

Required deterministic tests:

- Stall login A, complete Sign Out, then resolve A; no secret or signed-in state
  may reappear.
- Deliver a valid automatic sync after intentional Sign Out; it remains signed
  out until an explicit Sign In clears the latch.
- Resolve two login attempts in reverse order; only the latest intent commits.
- Fail each persistence step/migration and prove the old complete snapshot or
  new complete snapshot is visible, never a mixture.
- Rotate A to B between judge metadata and mutation; all requests either use one
  A snapshot or abort—none combine A/B fields.
- Simulate owner and observer windows for A→B and sign-out. Identity, profile,
  tree, and the credential used by commands converge exactly once.

Suggested commit boundaries:

1. Auth coordinator and deferred-race tests.
2. Single-record SecretStorage migration and immutable request snapshots.
3. Cross-window reconciliation and intentional-sign-out UX.

### Phase 2 — Make remote data generation-owned and failure-preserving

Closes A4-03, A4-04, and A4-05.

1. Replace `IProblem[]`/`[] on catch` with an explicit catalog result that
   distinguishes success, authentic empty data, transient failure, and
   signed-out invalidation. Swap the cache only after validated success.
2. Key retained catalog data by endpoint and account revision. Show loading,
   stale/error, and Retry states instead of a normal empty category tree.
3. Treat missing or malformed REST catalog fields as schema failure and invoke
   GraphQL fallback. Add a hard page cap plus repeated-page/slug forward-progress
   detection to fallback pagination.
4. Add one configuration coordinator with an explicit transition matrix:

   | Setting | Required transition |
   | --- | --- |
   | `leetcode.endpoint` | Confirm the account transition, invalidate auth/catalog/profile atomically, then load the new endpoint. Do not retain the old endpoint's identity beside new requests. |
   | `leetcode.useEndpointTranslation` | Invalidate/refetch endpoint-keyed catalog and active problem view as applicable. |
   | `leetcode.hideSolved` / sort strategy | Rebuild from cached catalog and fire one tree event; no network request. |
   | `leetcode.colorizeProblems` | Fire the decoration-provider change event. |
   | Known-broken `leetcode.cn` | Mark experimental/unavailable with an explicit caveat; do not offer incompatible Auto Sync. This is a UX guard, not a claim that `.cn` support was restored. |

5. Give each profile open/refresh an account revision and provider generation.
   Discard stale section success and failure callbacks. On sign-out, close or
   replace the panel with an explicit signed-out state; on account change,
   render one fresh shell for the new account.

Required deterministic tests:

- Seed a catalog, reject forced refresh, and return malformed REST data; the
  prior cache remains, the error is visible, and malformed REST invokes fallback.
- Repeat one full GraphQL page forever; loading terminates at the progress guard
  without unbounded memory growth.
- Drive every listed setting through `onDidChangeConfiguration` and assert the
  exact network/rebuild/decoration/auth effects.
- Resolve profile A after profile B and resolve an old failure after a new
  success; only the current account/generation reaches the panel.

### Phase 3 — Bound auth-sync lifecycle and make browser feedback truthful

Closes A4-06, A4-08, and A4-10.

1. Establish one end-to-end sync deadline shorter than the browser's deadline.
   Propagate its remaining budget/cancellation through Axios, curl, queued
   verification, and response handling.
2. Add header/body/idle deadlines, handle aborted/closed requests, track active
   sockets, and implement bounded graceful shutdown followed by socket
   destruction. Cancel delayed release work by server generation.
3. Make listener startup transactional: if owner-state persistence fails after
   bind, close the listener and remove incomplete ownership state before
   returning failure.
4. Replace boolean Auto Sync waiting with `signedIn | timedOut | cancelled |
   unavailable`. Dismissal and cancellation stop quietly; only a real timeout
   shows troubleshooting actions. Preflight disabled/conflict status.
5. Replace two-second login polling with auth-change events and make signed-out
   cleanup idempotent. Share one in-flight wait rather than creating duplicate
   polling loops.
6. Have browser `saveSettings` and clear operations return and validate their
   result. Disable controls during writes, restore the prior value on failure,
   and show cleanup success only after storage acknowledges it.

Required tests:

- Hold a raw partial POST open and require `stop()` to complete within the
  documented bound on the oldest supported Node host.
- Simulate slow Axios plus curl and a disconnected browser; no late credential
  commit, duplicate retry, or unbounded queue is allowed.
- Reject owner-state persistence after bind and prove the port is released.
- Fake two minutes of unchanged signed-out waiting and assert zero repeated
  keychain/Memento writes and no network calls.
- Exercise Escape, explicit Cancel, timeout, disabled listener, and conflict as
  distinct outcomes.
- Mock browser storage/runtime failures for every toggle and sensitive Clear;
  the control and status text must reflect persisted reality.

### Phase 4 — Make file and judge operations safe and discoverable

Closes A4-07, A4-09, and A4-11.

1. Resolve the selected root and nearest existing target ancestor physically;
   reject symlink/junction escape before writing. Cover case normalization and
   junction behavior on Windows.
2. Retire `leetcode.useWsl` from direct API/file I/O. Migrate it to a documented
   no-op/removal because a VS Code Remote WSL host already supplies Linux paths,
   while a native Windows extension host requires native `fsPath` values.
3. Generate content before touching the destination, then use an exclusive,
   no-replace write. Clean up only a temporary file owned by this operation.
   Never truncate an intervening file.
4. If the target exists, parse its metadata and compare it with the selected
   problem. Offer Open existing, Choose another path, or Cancel; never silently
   open a different problem under a constant filename.
5. Introduce one bounded solution-document classifier/parser. It must locate an
   end marker only after its matching start marker and inspect a bounded header
   for discovery. Reuse it for CodeLens, command validation, and menu context.
6. Maintain signed-in and valid-solution context keys so editor/explorer menus
   appear only where relevant. Direct command invocation must still explain a
   missing sign-in or invalid file.
7. Add a judge-operation ID, account revision, and CancellationToken. Propagate
   cancellation through HTTP, curl, poll sleeps, and result rendering. Present
   separate Test Result and Submission titles, and prevent an older completion
   from replacing the current panel.

Required tests:

- Temporary root plus external symlink and Windows junction fixture; generation
  is rejected without touching the external target.
- Gate the network fetch, create sentinel content at the target, then resume;
  sentinel content remains unchanged.
- Inject final-write failure; no empty destination or owned temp file remains.
- Exercise native Windows paths with `useWsl` migration and Remote WSL paths.
- Put a decoy end marker before the start and marker-like text inside code; only
  the matching post-start end marker terminates the solution.
- Verify context-key transitions for arbitrary, generated, edited, signed-out,
  and deleted files without reading an entire large document.
- Resolve Test and Submit in reverse order and cancel each polling stage; only
  the owning operation renders a correctly titled result.

### Phase 5 — Reduce startup cost and restore dependency gates

Closes A4-12 and A4-13.

1. Separate status/auth refresh from catalog invalidation. Keep the loopback
   listener available at startup, but load the catalog only when the explorer is
   first visible or a catalog-consuming command is invoked.
2. Instrument activation and first-explorer-use request counts. A hidden explorer
   must cause zero catalog requests; concurrent first consumers must share one.
3. Replace the Highlight.js root build with core plus explicitly supported
   languages, preserving safe plaintext fallback for unknown languages. Use
   per-method Lodash imports or small native helpers, and lazily initialize
   renderers that are not needed at activation.
4. Record the reduced bundle size and activation measurement, then tighten the
   package/bundle budget to the new steady state plus a documented tolerance.
5. Evaluate `sanitize-html@2.17.5` and a patched NanoID resolution first. Do not
   select `sanitize-html@2.17.6` without intentionally raising and testing the
   minimum VS Code/Node host. Re-run all sanitizer/CSP/package tests.
6. Triage the five remaining development-only advisory paths by shipped status,
   input trust, and upstream availability. Upgrade or override only with tool
   compatibility proof; document a time-bounded exception for unavoidable
   tooling residue rather than claiming a clean full graph.

Acceptance evidence:

- Hidden-explorer activation performs zero catalog requests; first use performs
  exactly one and overlapping consumers coalesce.
- Unknown fenced languages render escaped plaintext and supported languages
  still highlight correctly after the bundle reduction.
- `npm audit --omit=dev` exits zero with a Node version compatible with the
  declared VS Code engine.
- The full audit's remaining result, if non-zero, has a current path-by-path
  development-only disposition and expiry.

### Phase 6 — Harden webview boundaries and accessibility

Closes A4-14 and A4-15.

1. Serialize or validate markdown font settings as CSS data; never interpolate
   raw configuration into HTML. Add `</style>`, CSS delimiter, quote, and URL
   regression cases.
2. Give every webview a CSP that matches what it actually emits. Prefer
   nonce-backed or external extension styles, remove inline body style, and
   retain `default-src 'none'`, disabled command URIs, and the minimum image/font
   origins each panel needs.
3. Add accessible problem state text/labels and useful tooltips without relying
   on icon or color alone.
4. Mark profile sections busy while loading, announce success/error changes,
   use semantic tables/lists with headers or captions, honor
   `prefers-reduced-motion`, and verify narrow/zoomed layouts.
5. Replace fixed browser/profile state colors with VS Code/theme-safe tokens or
   palettes that meet WCAG AA contrast for their text size in light, dark, and
   high-contrast modes.

Required tests and manual proof:

- Render adversarial font-family values and assert they cannot create an element,
  handler, URL load, or extra style rule outside the serialized property.
- Parse every generated webview CSP and assert emitted inline/script/style/image
  resources are either authorized intentionally or absent.
- Add deterministic contrast checks and rendered markup assertions.
- Run native VS Code keyboard-only, screen-reader, 200% zoom, reduced-motion,
  light/dark/high-contrast checks; browser popup/options need the equivalent
  Chrome and Firefox pass.

### Phase 7 — Close public and diagnostic contracts

Closes A4-16.

1. Either implement Delete Cache as an observable catalog invalidation or remove
   the public command and documentation.
2. Make Submission honor `enableSideMode`, or narrow the setting description to
   the surfaces it actually controls.
3. Give the signed-out status item discoverable sign-in text/tooltip, or document
   that the explorer is the sole entry point and remove the inert item.
4. Add one redacting `reportCommandError(operation, error)` path that logs the
   actual exception before offering to open the output channel. Never log
   cookies, secrets, authorization, CSRF values, or captured browser payloads.

Required tests:

- Manifest/command tests prove every contributed public command has a real
  effect or is deliberately hidden.
- Side-mode tests cover preview, solution, test, and submission panels.
- Failure-path tests assert useful redacted output exists before the dialog
  promises it.

## Recommended Commit Sequence

Keep each row independently green and bisectable; do not combine the dependency
upgrade or bundle rewrite with auth correctness changes.

| Order | Focus | Findings |
| --- | --- | --- |
| 1 | Deferred auth-intent regression tests and coordinator | A4-01 |
| 2 | Atomic secret snapshot, request snapshot, and migration | A4-02 |
| 3 | Cross-window convergence and durable sign-out UX | A4-01, A4-02 |
| 4 | Catalog failure/progress semantics | A4-03 |
| 5 | Configuration matrix and profile generations | A4-04, A4-05 |
| 6 | Listener deadlines, shutdown, startup rollback, and wait state | A4-06, A4-08 |
| 7 | Browser save/clear acknowledgements and DOM tests | A4-10 |
| 8 | Physical path containment and no-clobber generation | A4-07 |
| 9 | Solution classifier, context menus, and judge cancellation | A4-09, A4-11 |
| 10 | Lazy catalog activation and bundle reduction | A4-12 |
| 11 | Compatible dependency remediation | A4-13 |
| 12 | Webview CSP/config serialization and accessibility | A4-14, A4-15 |
| 13 | Public command and error-reporting contracts; closure docs | A4-16 |

## Closure Ledger — 2026-08-11

“Source closed” means the broken invariant has an implementation and local
regression evidence. It does not convert an unrun environment-dependent check
into proof.

| Findings | Source closure | Focused commits | Local evidence | Remaining release proof |
| --- | --- | --- | --- | --- |
| A4-01, A4-02 | Source closed | `96418a1`, `788e1ca`, `5c9eb8e` | Auth intent races, serialized atomic snapshot persistence/migration, immutable request snapshots, remote snapshot events, and durable sign-out tests. | Real two-window A→B/sign-out/takeover and live account-header precedence. |
| A4-03 | Source closed | `136ae4d` | Last-known-good catalog retention test; validated REST/fallback and bounded GraphQL progress in source. | Live malformed/fallback behavior against current LeetCode schemas. |
| A4-04, A4-05 | Source closed | `063dcd2` | Deterministic setting-transition and stale profile-generation tests. | Native Settings UI, profile panel, and real endpoint/account transitions. |
| A4-06, A4-08 | Source closed | `197c0b4` | Raw partial-request shutdown bound; event-driven sign-in wait and transactional listener startup in source. Auth validation inherits the remaining request deadline. | Oldest supported VS Code/Node host, disconnected browser, and real owner handoff. |
| A4-10 | Source closed | `f907801` | Browser VM harness verifies option rollback and failed sensitive Clear feedback. | Packaged Chrome/Firefox storage and permission failures. |
| A4-07 | Source closed | `b547c62` | macOS external-symlink rejection and exclusive-write/no-replace tests; obsolete `useWsl` contract removed. | Windows junction, UNC, case normalization, and Remote WSL. |
| A4-09, A4-11 | Source closed | `40317e8`, `9a7b446` | Marker ordering, bounded header ownership, newest-operation rendering, cancellable sleeps, and live local-socket Axios abort. Curl is killed from the same cancellation callback. | Live Test/Submit cancellation at each LeetCode judge stage. |
| A4-12 | Source closed | `9c49a77` | Hidden explorer no longer fetches on auth status; first consumers share the cache. Supported/unknown highlighting tests pass. Package gate reports a 2.24 MiB bundle under a 3 MiB ceiling. | Native activation/request instrumentation. |
| A4-13 | Source closed for production | `87169f0` | `sanitize-html@2.17.5`, `nanoid@3.3.17`, sanitizer suite, package build, and `npm audit --omit=dev` exit zero. | Five development-only advisory nodes remain under the maintainer-guide exception expiring 2026-09-30. |
| A4-14, A4-15 | Source closed | `ce3cb6b` | CSS-context adversarial tests, nonce-backed inline styles, semantic profile status/tables, text problem states, reduced-motion rules, and deterministic browser button contrast checks. | Native screen reader, keyboard, high contrast, 200% zoom, narrow layout, and real-browser visual checks. |
| A4-16 | Source closed | `02ef460` | Delete Cache effect and diagnostic redaction tests; Submission side mode and signed-out status text are implemented. | Native command/menu/panel interaction sweep. |

Final local matrix after a clean `npm ci --ignore-scripts`:

| Check | Result |
| --- | --- |
| `npm run compile` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed: 89 offline tests, browser DOM/syntax checks, and package verification. |
| `npm audit --omit=dev` | Passed: zero vulnerabilities. |
| `npm audit` | Expected exception: five high-severity development-only nodes (`web-ext`, `addons-linter`, `image-size`, `fast-uri`, `js-yaml`). |
| `npm run auth-sync:lint:firefox` | Passed with two compatibility warnings and no errors. |
| Chrome and Firefox package builds | Passed. |
| Temporary VSIX build | Passed: 82 files, 1.35 MB archive, 2.24 MiB runtime bundle. |

## Final Verification Matrix

Run after the relevant focused commit and again on the final integrated tree:

```text
npm ci --ignore-scripts
npm run compile
npm run lint
npm test
npm audit --omit=dev
npm audit
npm run auth-sync:lint:firefox
npm run auth-sync:build:chrome
npm run auth-sync:build:firefox
npm run build -- --out <temporary-path>/vscode-leetcode-auth-sync.vsix
```

Also perform these environment-dependent checks before release:

| Surface | Required proof |
| --- | --- |
| Live LeetCode | Fresh ignored fixture; authenticated profile/catalog/detail/solution checks. Enable Favorite/Submit mutation flags only deliberately. Record account and endpoint without recording credentials. |
| Multi-window VS Code | Owner/observer A→B switch, sign-out, owner exit/takeover, concurrent manual/browser intent, and shared-profile/tree convergence. |
| Oldest supported host | Compile/package compatibility plus auth partial-request shutdown and deadline behavior on the Node runtime shipped by the minimum supported VS Code. |
| Windows and Remote WSL | Native drive/UNC paths, junction containment, file generation, Test, Submit, and migration of `leetcode.useWsl`. |
| Chrome and Firefox | Install packaged artifacts; success, storage failure, disabled permission, timeout/cancel, sensitive Clear, and account-switch behavior. |
| Accessibility | Keyboard, focus, screen reader, high contrast, 200% zoom, narrow panel, and reduced motion for explorer/profile/submission/browser UI. |

## Intentional Non-Changes

- Do not make `leetcode.authSync.secret` mandatory or auto-generate it. The
  loopback-only no-`Origin`, no-secret path remains the documented zero-config
  trade-off; the plan changes auth intent/lifecycle ownership, not that boundary.
- Do not remove the `vscode://…?cookie=` Web Authorization flow as session
  fixation. It remains the documented opt-in legacy path behind VS Code's URI
  prompt; it must simply participate in the shared auth coordinator.
- Keep credentials and captured browser request material in SecretStorage. No
  remediation may move them to Memento or logs.
- Do not claim `.cn` support was repaired. A4-04 adds honest UX around its
  already-documented broken state until a separately scoped restoration is
  implemented and tested.
- Do not describe the current sanitizer advisory as an exploitable application
  vulnerability without a reproducer through the actual allow-list.
- Retain the already-verified redirect protections, replay-header allow-list,
  constant-time secret comparison, request size limits, Favorite page cap, and
  generated-package exclusions.

## Proof Gaps

This audit was source-based plus deterministic local checks. It did not execute:

- a fresh authenticated LeetCode session or account-mutating live tests;
- a native VS Code extension host or real two-window ownership handoff;
- Windows, junction, UNC, Remote WSL, or the oldest supported VS Code/Node host;
- a real packaged Chrome/Firefox install and storage/permission failure;
- screen-reader, keyboard-only, zoom, high-contrast, or reduced-motion checks;
- live verification of whether LeetCode prioritizes a replayed Authorization
  header or Cookie when they represent different accounts.

The browser gate now syntax-checks scripts and exercises option rollback,
sensitive-clear failure, reduced-motion presence, and primary-button contrast in
a VM DOM harness. It still does not replace a packaged install in Chrome or
Firefox. The closure ledger therefore separates implemented/local proof from
manual release proof instead of claiming those environments were exercised.
