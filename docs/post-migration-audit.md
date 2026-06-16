# Post-migration audit — findings & fixes

> Audit of the codebase after the `vsc-leetcode-cli` migration (see
> [migration-off-cli.md](migration-off-cli.md)). Last updated 2026-06-16.
> Each finding is tracked to a fix commit. The `leetcode.cn` findings are
> **documented, not fixed** — CN support is currently broken and PRs are welcome.

## Status at a glance

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Whole catalog re-fetched on every tree refresh (star / sort / startup) | 🔴 High | ⬜ Open |
| 2 | Favorites & solutions broken on `leetcode.cn` | 🟠 Medium | 📄 Documented — won't fix (PRs welcome) |
| 3 | Unbounded favorites pagination loop | 🟠 Medium | ⬜ Open |
| 4 | Preview webview XSS hardening (`'unsafe-inline'` + regex sanitizer) | 🟡 Low | ⬜ Open |
| 5 | Inline `$…$` math false positives (currency) | 🟡 Low | ⬜ Open |
| 6 | Redundant question-detail fetch when opening a problem | 🟡 Low | ⬜ Open |
| 7 | No HTTP request timeout | ⚪ Minor | ⬜ Open |
| 8 | Silent favorites degradation | ⚪ Minor | ⬜ Open |
| 9 | Empty code body when a language has no snippet | ⚪ Minor | ⬜ Open |
| 10 | KaTeX CSS path is build-layout-relative | ⚪ Minor | ✅ Acceptable (no action) |

Legend: ✅ fixed/acceptable · ⬜ open · 📄 documented (won't fix)

---

## Findings

### 1 — Whole catalog re-fetched on every tree refresh 🔴 *(Open)*

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

**Fix.** Cache the catalog in `explorerNodeManager`; `refreshCache(force)` only
re-fetches when forced (or the cache is empty), otherwise rebuilds the trees from
the cached data. Star and sort become "soft" refreshes (local update + re-render,
no network). Gate `refreshUserStatus`'s emit on an actual identity change so a
no-op cookie re-verify no longer triggers a refetch. Also guard against
overlapping `refreshCache()` calls with an in-flight promise.

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

### 3 — Unbounded favorites pagination loop 🟠 *(Open)*

**Symptom / risk.** `getFavoriteProblemSlugs()` in
[leetcode-api.ts](../src/request/leetcode-api.ts) loops on the server's `hasMore`
flag but does **not** bound itself by `totalLength` (which it selects and then
ignores). The sibling problem-list loop *is* bounded (`skip < total`). Live
probing showed the server ignores the `limit` argument, so if a large favorites
list ever returns `hasMore: true` while `skip` is not honored, the loop spins
forever. Low probability, but inconsistent and unsafe.

**Fix.** Bound the loop by `totalLength` and/or a hard max-iteration cap.

### 4 — Preview webview XSS hardening 🟡 *(Open)*

**Symptom.** The problem-description preview sets
`script-src vscode-resource: 'unsafe-inline'`
([leetCodePreviewProvider.ts](../src/webview/leetCodePreviewProvider.ts)) and the
description is sanitized with a **regex** (`textRenderer.sanitizeHtml`). The
event-handler strip requires whitespace before `on…`, so `<svg/onload=…>` slips
through, and `'unsafe-inline'` would let it run. Practical risk is low
(descriptions are LeetCode-authored; the solution webview already drops
`'unsafe-inline'`), but the combination is fragile.

**Fix.** Give the preview's own inline script a per-render **nonce** and use
`script-src vscode-resource: 'nonce-…'` instead of `'unsafe-inline'`, so injected
scripts/handlers cannot run regardless of sanitizer gaps.

### 5 — Inline `$…$` math false positives 🟡 *(Open)*

**Symptom.** `extractMathPlaceholders` treats any `$…$` on a line as LaTeX, so a
description with literal currency ("you have $5 and $3") renders the span between
the dollar signs as garbled math.

**Fix.** Adopt the common currency guard: only treat `$…$` as math when the
character after the closing `$` is **not a digit** (and the opening `$` is not
followed by whitespace), so paired currency amounts are left alone.

### 6 — Redundant question-detail fetch when opening a problem 🟡 *(Open)*

**Symptom.** `showProblemInternal` fetches the full question detail to generate
the file, then `showDescriptionView` → `previewProblem` fetches it **again** for
the webview when the description mode is "In Webview"/"Both"
([show.ts](../src/commands/show.ts)). One extra network round-trip per problem
open.

**Fix.** Have the file generator return the detail it fetched and pass it through
to `previewProblem`, which fetches only when a detail is not supplied.

### 7 — No HTTP request timeout ⚪ *(Open)*

**Symptom.** `requestJson` ([leetcode-http.ts](../src/request/leetcode-http.ts))
issues axios requests with no `timeout`; a hung socket hangs the whole refresh —
now amplified because a refresh is 30+ requests.

**Fix.** Set a sensible default `timeout` on the axios request (respecting any
caller-provided value) and a matching `--max-time` on the curl fallback.

### 8 — Silent favorites degradation ⚪ *(Open)*

**Symptom.** If the favorites fetch fails, `safeGetFavoriteSlugs`
([list.ts](../src/commands/list.ts)) falls back to `isFavor` — which is now always
`false` — so the Favorite tree silently empties with no signal to the user.

**Fix.** Log the failure to the LeetCode output channel so it is diagnosable
rather than silent.

### 9 — Empty code body when a language has no snippet ⚪ *(Open)*

**Symptom.** If a problem has no `codeSnippet` for the chosen language,
`generateSolutionFileContent` writes an empty code block between the `@lc`
markers with no warning.

**Fix.** Warn the user (without blocking generation) when the picked language has
no snippet for the problem, so the empty scaffold is explained.

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
