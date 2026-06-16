# Migrating `leetcode-vscode` off `vsc-leetcode-cli`

> **Living execution plan.** Last updated 2026-06-15.
> Grounded in the actual repo state, not a blank-page rewrite.

## Goal

Replace bundled `vsc-leetcode-cli` calls with direct LeetCode HTTP/GraphQL/REST
requests using synced browser cookies, then remove the CLI dependency safely.

## Ground rules

- Keep public extension behavior stable while migrating.
- Prefer typed API results over reproducing CLI text output.
- Keep the CLI fallback **during migration only**.
- **Do not** fall back to the CLI after a confirmed LeetCode/Cloudflare rejection
  from the direct path.
- Treat `leetcode.cn` as *inherited* support, not freshly validated support,
  until explicitly tested.

---

## Status at a glance

| Phase | Title | Status |
|---|---|---|
| 0 | Baseline & test net | ✅ Done (`39ce44b`) |
| — | Browser dev-mode + live integration harness | ✅ Done (`5caee5f`) |
| — | E2E sanity tests + `nameTranslated` fix | ✅ Done (uncommitted) |
| 1 | Consolidate the HTTP layer | ✅ Done (`39ce44b`) |
| 2 | Problem identity model | ✅ Done |
| 3 | Wire problem list + vendor companies/tags | ✅ Done |
| 4 | Description + template generation (+ KaTeX, slug hardening) | ⬜ Not started |
| 5 | Auth/login off the CLI | ⬜ Not started |
| 6 | Sessions | ⬜ Not started — ⚠️ scope grew (see phase) |
| 7 | Favorites | ⬜ Not started |
| 8 | Solutions / discussions | ⬜ Not started |
| 9 | Remove the CLI | ⬜ Not started |
| 10 | Docs & validation | ⬜ Not started |

Legend: ✅ done · 🟡 in progress · ⬜ not started

---

## TL;DR verdict

Codex's original plan is **directionally sound and well-sequenced**, but it's
written as if you're starting from a blank page. You're not. The hard parts of
the HTTP/GraphQL foundation already exist and work, and a large chunk of the
"to-build" API client was **already written but wired into nothing**. So the real
job is **wire + consolidate + delete**, not *author*. The original plan also
missed three things that actually bite: a duplicate/inconsistent HTTP stack, a
slug-recovery coupling between template generation and the *already-migrated*
submit/test path, and the fact that startup still hard-depends on the CLI.

---

## Ground truth: what's wired today

Traced from every `leetCodeExecutor.*` call and every importer of the request
modules. Status column updated as phases land.

| Capability | Real backend today | Notes |
|---|---|---|
| **Submit / Test** | ✅ Direct API (CLI fallback) | `submit-solution.ts` / `test-solution.ts` → `leetcode-http.ts`. Already done before this migration. |
| **Sign-in user identity** | ✅ Direct API | `leetCodeManager` → `fetchUserStatus()` → `requestJson` (curl/Cloudflare fallback). **Phase 1 consolidated this off the old weak `LcAxios` layer.** |
| **Startup login check** | ❌ CLI | `getLoginStatus()` → `leetCodeExecutor.getUserInfo()`. **Activation still shells out to the CLI.** → Phase 5. |
| **Problem list** | ✅ Direct API | `list.ts` → `leetcode-api.listProblems()`; companies/tags from the vendored `src/data/companiesTags.ts` snapshot. **Phase 3 deleted the regex parse + `getCompaniesAndTags()` plugin read.** |
| **Description / template / solution** | ❌ CLI | `show.ts` → `getDescription`, `showProblem`, `showSolution`. → Phases 4 / 8. |
| **Sessions** | ❌ CLI | `session.ts`. The direct-API replacement is **not** a drop-in — the REST `/session/` endpoint is gone (see Phase 6). |
| **Favorites** | ❌ CLI | `star.ts` → `toggleFavorite`. → Phase 7. |
| **Switch endpoint** | ❌ CLI plugin | `switchEndpoint` enable/disables the `leetcode.cn` CLI plugin. Collapses to a settings write. → Phase 9. |
| **`leetcode-api.ts`** (list/detail/userStatus/sessions, global+CN mappers) | ⚠️ Mostly written, wired only for `fetchUserStatus` | The rest (`listProblems`, `getQuestionDetail`, session CRUD) is verified by live tests but not yet consumed by any command. |

So the original Phases 3 and 6 are ~80% *coded* already; the work is to
**consume** `leetcode-api.ts` and delete the CLI callsite, not write it.

### Three things to watch

1. **Three HTTP layers, inconsistent resilience** *(resolved in Phase 1).*
   `leetcode-http.ts::requestJson` is robust (axios → curl on Cloudflare, typed
   `DirectApiUnsupportedError`); `leetcode-api.ts` reuses it; but sign-in used to
   go through `utils/httpUtils.ts::LcAxios` (plain axios, `any`, no curl
   fallback) — a latent *"sign-in fails under Cloudflare even though submit
   works"* bug. Phase 1 routed sign-in through `requestJson` and deleted the weak
   layer. Duplicate `getQuestionDetail` (lite in `-http`, full in `-api`) is kept
   **deliberately** (lean judge path vs. full display) and now documented.

2. **Slug-recovery coupling — the biggest correctness risk** *(pending, Phase 4).*
   Submit/test are *already* migrated and recover `titleSlug` from the solution
   file via `parseSlug()`: it looks for a `leetcode.com/problems/<slug>` URL in
   the comment, else falls back to the `<frontendId>.<slug>.<ext>` **filename**
   pattern. Today the CLI writes the file. The moment *you* own template
   generation (Phase 4), if you don't embed the slug, custom filename configs
   (e.g. `${camelCaseName}.${ext}`) will silently break the already-working
   submit path. **Fix: embed the canonical problem URL in the `@lc` header** so
   the URL branch of `parseSlug` always wins, independent of filename.

3. **Startup hard-depends on the CLI** *(pending, Phase 5).*
   `getLoginStatus()` (activation hot path) calls CLI `user`, and activation
   gates on `meetRequirements()` which checks Node and installs CLI plugins. The
   "starts without Node" goal fails unless these are neutralized *early*, not at
   the final "remove fallback" phase.

Minor: `switchEndpoint` is effectively a no-op for the direct path (endpoint is
resolved purely from the `leetcode.endpoint` setting via `getUrl()`), so it
collapses to a settings write.

---

## What to borrow from `better-leetcode`

Caveat: it's a *different* architecture (no CLI, no browser-extension sync; it
uses web-authorize/CSRF + manual cookie paste) and — importantly — **it has no
Cloudflare handling at all**, so our `leetcode-http.ts` transport is actually
*more* robust. Borrow patterns and specific modules, not the transport or the
auth model.

| From better-leetcode | Borrow for | Verdict |
|---|---|---|
| `src/utils/textRenderer.ts` | Phase 4 (description) + Phase 8 (solutions) | **Strong borrow.** Pipeline: decode double-escapes → pull `$$…$$`/`$…$` into placeholders → markdown → XSS-sanitize (iframes whitelisted to LeetCode) → **KaTeX** render with literal fallback. Adapt the math-placeholder + KaTeX step onto the existing markdown-it/highlight.js (adds a `katex` dep) rather than swapping to `marked`. |
| `src/leetcode/client.ts` (method surface) | Phases 3/7/8 + consolidation | **Borrow the shape, not the transport.** Confirms the favorites approach (`getFavoriteLists` → `getFavoriteListProblems`) for Phase 7, and gives a clean single-client API surface to consolidate toward. Keep our curl fallback; theirs lacks it. |
| `src/test/suite/*.test.ts` + `snapshot.ts` | Phase 0 | **Borrowed.** Snapshot/unit tests over fixture responses for the mappers and `parseSolutionFile`/`parseSlug`. Implemented as the Phase 0 test net. |
| `src/leetcode/boilerplate.ts` | Phase 4 | **Low priority.** Its wrap-imports/strip-on-submit scheme is *incompatible* with our `@lc code=start/end` markers — don't adopt it. Only steal the idea of injecting editor-friendly imports *if* it survives the existing extractor. |
| `src/leetcode/auth.ts` (web-authorize) | Future | **Optional.** A CSRF web-login as a *secondary* fallback when the browser extension isn't installed. Not a replacement for the sync model. |
| Daily Challenge / Study Lists / Contests tree providers | Post-migration | Out of scope, but good follow-up feature ideas once off the CLI. |

---

## Execution plan (grounded, reordered)

Renumbered to match reality. Big changes vs. the original: a **Phase 0 test
net**, a dedicated **HTTP-consolidation phase**, **per-phase deletion + smoke
test** instead of a big-bang fallback removal, and explicit handling of the slug
coupling and startup dependency.

### Phase 0 — Baseline & test net ✅
- Mocha harness that runs **without the Extension Host** (a `vscode` stub +
  `Module._load` require hook), kept out of the production build and the VSIX.
- Fixtures (`src/test/fixtures/leetcode-responses.ts`) + unit tests for the
  mappers (`mapGlobalProblem`/`mapCnProblem`/`mapQuestionDetail`/`mapSession`,
  `formatAcceptanceRate`) and `parseSolutionFile`/`parseSlug`/`parseCode`.
- **Done:** `npm test` runs offline and green (15 tests); a broken mapper fails a
  test. Committed in `39ce44b`.

### Phase 0a — Browser dev-mode + live integration harness ✅ *(added)*
- Browser extension **Developer mode** (opt-in) that captures the exact
  cookie/header payload sent to VS Code and copies it as a test fixture.
- VS Code live-test harness (`src/test/integration/`) that loads a **local-only**
  auth fixture (`src/test/.secrets/leetcode-auth.local.json`), seeds an in-memory
  `globalState`, and self-skips when no fixture is present.
- Secret protection: `.gitignore` (primary) + opt-in pre-commit hook
  (defense-in-depth). Committed in `5caee5f`.

### Phase 0b — E2E sanity tests ✅ *(added, uncommitted)*
- `src/test/integration/leetcode-api.live.ts`: auth, problem catalog
  (well-formed, unique slugs, sorted by id, two-sum = #1), full + light question
  detail with a cross-path `questionId` consistency check, and an **opt-in**
  (`LEETCODE_LIVE_SUBMIT=1`) real-submit test.
- These caught two real bugs immediately:
  - **Fixed:** full `getQuestionDetail` sent `topicTags { … nameTranslated }` to
    *both* endpoints, but `nameTranslated` only exists on the `.cn` schema → the
    `.com` GraphQL endpoint rejected the whole query with **HTTP 400**. Made the
    tag selection endpoint-aware.
  - **Found:** the REST `/session/` endpoint is deprecated (**HTTP 405**) — see
    Phase 6.

### Phase 1 — Consolidate the HTTP layer ✅
- Routed `fetchUserStatus` (sign-in identity) through `requestJson` so it inherits
  curl/Cloudflare handling; **deleted** `utils/httpUtils.ts` (`LcAxios`) and
  `query-user-data.ts`.
- Reconciled the `userStatus` duplication onto one source; kept the
  `getQuestionDetail` lite-vs-full split deliberately and documented it.
- **Done:** every direct call goes through one transport. Committed in `39ce44b`.

### Phase 2 — Problem identity model ✅ *(keystone — first among migrations)*
- Extended `IProblem` with `questionFrontendId`, `questionId?`, `titleSlug?`; kept
  `id` = frontend id (the user-facing display id) for backwards compatibility.
  Updated `defaultProblem` and added `LeetCodeNode` getters
  (`questionFrontendId`/`questionId`/`titleSlug`). `problemUtils` file↔node
  resolution already keys off the frontend id (`@lc id=`), so it was left intact.
- The CLI `list.ts` path now stamps `questionFrontendId = id`; `questionId` and
  `titleSlug` stay `undefined` until the API list lands in Phase 3.
- **Done:** explorer renders unchanged; `${...}` placeholders and file naming
  unchanged; the identity fields are now available for the migrations downstream
  (Phase 4 slug embed, Phase 7 favorites) instead of re-deriving a slug from the
  display title. Compiles; offline test net green (15 tests).

### Phase 3 — Wire problem list + vendor companies/tags ✅
- Swapped `list.ts` to `leetcode-api.listProblems()`, mapping each
  `ILeetCodeProblem` → `IProblem` (now carrying `questionId`/`titleSlug`).
  Deleted the CLI-text regex parse, `parseProblemState`, and the trailing
  `.reverse()` (the API already returns the catalog sorted ascending by frontend
  id). Removed `getCompaniesAndTags()` and its `require-from-string` import from
  `leetCodeExecutor` (the npm dep is dropped in Phase 9).
- **Vendored** the static `COMPONIES`/`TAGS` tables into `src/data/companiesTags.ts`
  (506 company entries, 984 tag entries, exported as `COMPANIES`/`TAGS`), extracted
  verbatim from `vsc-leetcode-cli@2.8.1`. Labeled inherited/frozen; companies stay
  vendored because the free API has no per-problem company data. `list.ts` keeps
  the exact `COMPANIES[id] || ["Unknown"]` / `TAGS[id] || ["Unknown"]` behavior.
- **Done:** explorer loads from the API; company/tag trees populate from vendored
  data; sort (acceptance rate) / hide-solved / locked behavior preserved.
  Compiles; offline test net green (17 tests, +2 vendored-data sanity guards).

### Phase 4 — Description + template generation ⬜ *(+ slug hardening + KaTeX)*
- `previewProblem`/`showProblemInternal` use `getQuestionDetail`; generate the
  file from `codeSnippets`.
- **Embed the canonical `https://leetcode.com/problems/<titleSlug>/` URL in the
  `@lc` header** so the existing submit/test `parseSlug` recovers the slug for
  *any* filename config.
- Render description with the borrowed math-placeholder + KaTeX pipeline.
- **Done when:** the generated file's slug round-trips through the existing
  submit/test parser for both default and custom filenames; preview renders
  LaTeX; "description in comment" preserved.

### Phase 5 — Auth/login off the CLI ⬜ *(startup-critical, pull early)*
- Replace `getLoginStatus()`'s CLI `getUserInfo` with cached `globalState` status
  + direct `fetchUserStatus`. Drop `setCookieToCli`, the cookie-login CLI spawn,
  and make `signOut` clear `globalState` only.
- Neutralize `meetRequirements()` so activation needs neither Node nor CLI-plugin
  installs; ensure `extension.ts` doesn't gate activation on it.
- **Done when:** cold start on a machine with **no Node** still activates and
  shows the signed-in user.

### Phase 6 — Sessions ⬜ *(⚠️ scope grew — not "just wire")*
- **Originally** "just point `session.ts` at the already-written `leetcode-api`
  session CRUD." But the live tests proved the legacy REST `/session/` endpoint
  is **gone**: `POST`/`PUT` return **HTTP 405** and `GET` serves HTML, not JSON.
- Real work: **reimplement** `listSessions`/`activateSession`/`createSession`/
  `deleteSession` on LeetCode's current **GraphQL** API (confirm operation
  names/fields empirically — don't guess the schema), then re-enable the
  `describe("sessions")` live test (currently a documented `it.skip`).
- **Done when:** manage / create / switch / delete work via GraphQL and the
  explorer refreshes; the live session test asserts a real result.

### Phase 7 — Favorites ⬜
- With a real cookie, query the favorites list to get the favorite slug; add
  `add/removeQuestionToFavorite` using `questionId` (not frontend id); wire
  `star.ts`.
- **Done when:** add/remove reflect in the Favorite tree and on leetcode.com.

### Phase 8 — Solutions / discussions ⬜ *(lowest fidelity)*
- Replace `show --solution` with the solution-article / discussion GraphQL;
  render in a webview (borrow DiscussionWebview pagination + textRenderer).
  Normalize `python3`/`python`. Keep CN explicitly marked inherited.
- **Done when:** a readable top solution renders; missing-solution gives a clear
  empty state.

### Phase 9 — Remove the CLI ⬜
- Drop `vsc-leetcode-cli` and `require-from-string` deps; delete
  `leetcode.nodePath`; collapse `switchEndpoint` to a settings-only write; make
  `deleteCache` a deprecated no-op; remove `leetCodeExecutor` shell-outs and
  binary-path code. Keep WSL path utils only if still used for file paths.
- **Done when:** no import/spawn of the CLI; `npm install` doesn't fetch it;
  compiles and launches.

### Phase 10 — Docs & validation ⬜
- README auth-sync diagram (drop CLI session/cache), requirements (drop Node),
  settings table, changelog. Smoke matrix on `leetcode.com`; mark `leetcode.cn`
  inherited unless CN smoke tests are actually run.

---

## Sequencing rationale

**0 → 1 → 2** are prerequisites for trusting any direct path (net, single
transport, identity). Then **3, 4, 6** are mostly wiring existing code — except
**6**, where the dead REST endpoint forces a GraphQL reimplementation. **5** moves
earlier than the original plan because it's on the activation hot path. Each
migration phase **deletes its CLI callsite and adds a smoke test as it lands**, so
Phase 9 ("remove dependency") is a formality, not a cliff. Honor the
`allowCliFallback` flag *only* until each path's callsite is deleted — and per the
ground rules, never fall back after a confirmed Cloudflare/LeetCode rejection.

---

## Progress log

| When | Commit | What |
|---|---|---|
| 2026-06-15 | `39ce44b` | Phase 0 (offline test net) + Phase 1 (HTTP consolidation onto `requestJson`; deleted `query-user-data.ts` + `httpUtils.ts`). |
| 2026-06-15 | `5caee5f` | Browser dev-mode capture + live integration harness with local-only secret protection. |
| 2026-06-15 | *(uncommitted)* | E2E sanity tests; fixed the `.com` `nameTranslated` HTTP 400 bug; documented the `/session/` 405 deprecation (Phase 6). |
| 2026-06-15 | *(this branch)* | Phase 2: extended `IProblem`/`defaultProblem`/`LeetCodeNode` with the `questionFrontendId`/`questionId`/`titleSlug` identity model. |
| 2026-06-15 | *(this branch)* | Phase 3: `list.ts` now reads the API (`listProblems()`); vendored `src/data/companiesTags.ts`; deleted the CLI regex parse + `getCompaniesAndTags()`. |
