# Post-migration audit — findings & fixes

> Audit of the codebase after the `vsc-leetcode-cli` migration (see
> [migration-off-cli.md](migration-off-cli.md)). Last updated 2026-06-16.
> Each finding is tracked to a fix commit. The `leetcode.cn` findings are
> **documented, not fixed** — CN support is currently broken and PRs are welcome.

## Status at a glance

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Whole catalog re-fetched on every tree refresh (star / sort / startup) | 🔴 High | ✅ Fixed |
| 2 | Favorites & solutions broken on `leetcode.cn` | 🟠 Medium | 📄 Documented — won't fix (PRs welcome) |
| 3 | Unbounded favorites pagination loop | 🟠 Medium | ✅ Fixed |
| 4 | Preview webview XSS hardening (`'unsafe-inline'` + regex sanitizer) | 🟡 Low | ✅ Fixed |
| 5 | Inline `$…$` math false positives (currency) | 🟡 Low | ✅ Fixed |
| 6 | Redundant question-detail fetch when opening a problem | 🟡 Low | ✅ Fixed |
| 7 | No HTTP request timeout | ⚪ Minor | ✅ Fixed |
| 8 | Silent favorites degradation | ⚪ Minor | ✅ Fixed |
| 9 | Empty code body when a language has no snippet | ⚪ Minor | ✅ Fixed |
| 10 | KaTeX CSS path is build-layout-relative | ⚪ Minor | ✅ Acceptable (no action) |

Legend: ✅ fixed/acceptable · ⬜ open · 📄 documented (won't fix)

---

## Findings

### 1 — Whole catalog re-fetched on every tree refresh 🔴 *(✅ Fixed)*

**Symptom.** Routine actions are slow. The CLI cached the problem list locally;
the direct path has no cache, so `leetCodeTreeDataProvider.refresh()` →
`explorerNodeManager.refreshCache()` → `list.listProblems()` re-fetches the
**entire ~3,000-problem catalog** (4 categories, ~30+ sequential paginated
requests) **plus** the favorites list, *every* time `refresh()` is called.

**Triggers (each = a full re-fetch):**
- Starring one problem — [star.ts](../src/commands/star.ts).
- Submitting — [submit.ts](../src/commands/submit.ts).
- Changing the sort order — [plugin.ts](../src/commands/plugin.ts) (sorting is
  purely client-side, yet refetches over the network).
- Every `statusChanged` — [extension.ts](../src/extension.ts). A signed-in cold
  start emits `statusChanged` **twice** (cached path + background re-verify in
  [leetCodeManager.ts](../src/leetCodeManager.ts)), so startup does **two** full
  catalog fetches (~60 requests). `refreshUserStatus` emits even when nothing
  changed.

**Fix (done).** `explorerNodeManager` now caches the fetched catalog
(`cachedProblems`); `refreshCache(force)` re-fetches only when `force` is true (or
the cache is empty) and otherwise rebuilds the trees from cache. `LeetCodeNode`
tree refreshes gained a `refresh(force = true)` flag: **star** (after a new
`setProblemFavorite` local update) and **sort** now soft-refresh (`refresh(false)`,
no network). `refreshUserStatus` only emits `statusChanged` on an actual identity
change, so a cached cold start does **one** fetch instead of two and a no-op
re-verify does none. Overlapping fetches are de-duplicated via an in-flight promise
(`fetchInFlight`). Compiles; offline net green (31 tests).

### 2 — Favorites & solutions broken on `leetcode.cn` 🟠 *(Documented — won't fix)*

CN support is **currently broken** for two of the migrated features. Documented
here rather than fixed; contributions are welcome.

- **Favorites.** `getDefaultFavoriteSlug()` in
  [leetcode-api.ts](../src/request/leetcode-api.ts) finds the user's default star
  list by matching the name **exactly equal to `"Favorite"`** (mirroring the old
  CLI). On `leetcode.cn` the default list is named **`"收藏"`**, so the lookup
  returns `undefined`. Consequences on CN: the Favorite explorer tree is always
  empty, and starring/unstarring throws *"Could not find your default Favorite
  list."* A fix would need a locale-aware default-list lookup (e.g. an
  `isDefault`-style flag if CN exposes one, or matching the localized name).
- **Solutions.** `getTopSolutionArticle()` uses the `ugcArticleSolutionArticles`
  / `ugcArticleSolutionArticle` GraphQL operations, which are the **`leetcode.com`**
  Solutions-tab schema. `leetcode.cn` exposes a different community-solutions API,
  so `showSolution` will error on CN.

More broadly, the direct-request paths added during the migration were validated
only against `leetcode.com`; other CN endpoints (problem detail extras, etc.) are
inherited and untested.

### 3 — Unbounded favorites pagination loop 🟠 *(✅ Fixed)*

**Symptom / risk.** `getFavoriteProblemSlugs()` in
[leetcode-api.ts](../src/request/leetcode-api.ts) loops on the server's `hasMore`
flag but does **not** bound itself by `totalLength` (which it selects and then
ignores). The sibling problem-list loop *is* bounded (`skip < total`). Live
probing showed the server ignores the `limit` argument, so if a large favorites
list ever returns `hasMore: true` while `skip` is not honored, the loop spins
forever. Low probability, but inconsistent and unsafe.

**Fix (done).** The loop now stops once `skip >= totalLength` and is wrapped in a
hard `FAVORITE_LIST_MAX_PAGES` (50 pages → 5,000) backstop, so it can no longer
spin even if the server reports `hasMore: true` without honoring `skip`.

### 4 — Preview webview XSS hardening 🟡 *(✅ Fixed)*

**Symptom.** The problem-description preview sets
`script-src vscode-resource: 'unsafe-inline'`
([leetCodePreviewProvider.ts](../src/webview/leetCodePreviewProvider.ts)) and the
description is sanitized with a **regex** (`textRenderer.sanitizeHtml`). The
event-handler strip requires whitespace before `on…`, so `<svg/onload=…>` slips
through, and `'unsafe-inline'` would let it run. Practical risk is low
(descriptions are LeetCode-authored; the solution webview already drops
`'unsafe-inline'`), but the combination is fragile.

**Fix (done).** The preview's own inline script now carries a per-render
`crypto.randomBytes` **nonce**, and the CSP uses
`script-src vscode-resource: 'nonce-…'` instead of `'unsafe-inline'`. Any script or
event handler injected through the description HTML is now blocked by the CSP,
independent of the (defense-in-depth) regex sanitizer. The `sanitizeHtml` pass is
kept; the solution webview already had no `'unsafe-inline'`.

### 5 — Inline `$…$` math false positives 🟡 *(✅ Fixed)*

**Symptom.** `extractMathPlaceholders` treats any `$…$` on a line as LaTeX, so a
description with literal currency ("you have $5 and $3") renders the span between
the dollar signs as garbled math.

**Fix (done).** The inline matcher is now `/\$(?!\$)(?!\s)([^$\n]+?)\$(?!\d)/g`:
the opening `$` must not be followed by whitespace and the closing `$` must not be
followed by a digit, so paired currency amounts ("you have $5 and $3") stay as
plain text. A regression test covers it; genuine inline math still renders.

### 6 — Redundant question-detail fetch when opening a problem 🟡 *(✅ Fixed)*

**Symptom.** `showProblemInternal` fetches the full question detail to generate
the file, then `showDescriptionView` → `previewProblem` fetches it **again** for
the webview when the description mode is "In Webview"/"Both"
([show.ts](../src/commands/show.ts)). One extra network round-trip per problem
open.

**Fix (done).** `generateProblemFile` now returns the `ILeetCodeQuestionDetail` it
fetched, `showProblemInternal` passes it to `showDescriptionView` → `previewProblem`,
and `previewProblem` gained a `prefetched?` parameter — it fetches only when no
detail is supplied. Opening a problem with the webview description is now one fetch
instead of two.

### 7 — No HTTP request timeout ⚪ *(✅ Fixed)*

**Symptom.** `requestJson` ([leetcode-http.ts](../src/request/leetcode-http.ts))
issues axios requests with no `timeout`; a hung socket hangs the whole refresh —
now amplified because a refresh is 30+ requests.

**Fix (done).** `requestJson` now applies a `DEFAULT_TIMEOUT_MS` (30s) axios
`timeout` (overridable per call), and the curl fallback passes a matching
`-m <seconds>` (`--max-time`). A stuck request now fails fast instead of hanging
the whole refresh.

### 8 — Silent favorites degradation ⚪ *(✅ Fixed)*

**Symptom.** If the favorites fetch fails, `safeGetFavoriteSlugs`
([list.ts](../src/commands/list.ts)) falls back to `isFavor` — which is now always
`false` — so the Favorite tree silently empties with no signal to the user.

**Fix (done).** `safeGetFavoriteSlugs` now logs the failure to the LeetCode output
channel (`[favorites] Could not load the Favorite list…`) before falling back, so
an empty Favorite tree is diagnosable instead of silent.

### 9 — Empty code body when a language has no snippet ⚪ *(✅ Fixed)*

**Symptom.** If a problem has no `codeSnippet` for the chosen language,
`generateSolutionFileContent` writes an empty code block between the `@lc`
markers with no warning.

**Fix (done).** `generateProblemFile` now checks whether `detail.codeSnippets`
contains the chosen `langSlug`; if not, it shows a non-blocking warning
("LeetCode has no `<lang>` code template…; generated an empty file") and still
writes the scaffold (markers intact).

### 10 — KaTeX CSS path is build-layout-relative ✅ *(Acceptable — no action)*

`markdownEngine.katexDistDir` resolves `katex.min.css` via a `__dirname`-relative
path (`out/src/webview` → `node_modules/katex/dist`). This is the standard
extension layout and is correct for the packaged VSIX; if the layout ever changed,
math would render unstyled but still legible (the renderer keeps a literal
fallback). No change needed — recorded for awareness.

---

## Progress log

| When | Commit | What |
|---|---|---|
| 2026-06-16 | *(this commit)* | Documented the post-migration audit findings. |
| 2026-06-16 | *(this branch)* | Fix #1: cache the catalog; star/sort soft-refresh; gate redundant status emits; de-dup overlapping fetches. |
| 2026-06-16 | *(this branch)* | Fix #3: bound the favorites pagination loop by `totalLength` + a 50-page backstop. |
| 2026-06-16 | *(this branch)* | Fix #4: nonce the preview's inline script; drop `script-src 'unsafe-inline'`. |
| 2026-06-16 | *(this branch)* | Fix #5: currency guard on the inline `$…$` math matcher (+ regression test). |
| 2026-06-16 | *(this branch)* | Fix #6: reuse the generated file's question detail for the webview preview (one fetch, not two). |
| 2026-06-16 | *(this branch)* | Fix #7: 30s default request timeout on axios + matching curl `--max-time`. |
| 2026-06-16 | *(this branch)* | Fix #8: log the favorites-fetch failure so an empty Favorite tree is diagnosable. |
| 2026-06-16 | *(this branch)* | Fix #9: warn when the chosen language has no code snippet (empty scaffold explained). |
