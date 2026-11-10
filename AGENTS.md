# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this before doing
a code review or security audit so you don't re-report decisions that are
intentional.

## Working approach

Act like a skeptical senior engineer. Inspect relevant code before editing,
identify root causes and broken invariants, and prefer the smallest safe change.
Add regression tests when practical, state exactly what was verified, and do not
perform unrelated refactors.

### Commit discipline

When making code changes, commit each completed independent unit of work before
starting another. Keep every commit focused and do not bundle unrelated changes.
Run checks appropriate to the change before committing; do not commit knowingly
broken or incomplete work merely to satisfy this rule. Preserve unrelated
user-owned working-tree changes unless the user explicitly asks to include them.

- Subject: lowercase Conventional Commit — `<type>: <concise lowercase summary>`
  (see `git log`, e.g. `989712a fix: fail closed on unreadable current auth records`).
- Add a body only when it records context, constraints, or verification the
  subject can't convey. When warranted, name the concrete module-level changes,
  call out intentionally preserved exceptions or boundaries, and end with the
  checks actually run and their results. Do not claim verification that did not
  occur.
- Pass multi-paragraph bodies with repeated `-m` arguments or `-F`; never embed
  literal `\n` escapes in a shell argument. Inspect `git log -1 --format=raw`
  before moving on.
- A parenthesized step label is appropriate only for an explicitly numbered
  migration or plan.

### Audit remediation

For audit-remediation work, keep an explicit closure ledger with three
categories: fixed and verified, intentionally not changed, and changed but not
fully proven. Do not summarize the audit as completely fixed while owner-choice
items or verification gaps remain; carry the ledger into
`docs/maintainer-guide.md` so the handoff distinguishes product risk from
optional cleanup and missing evidence.

### Regression tests and verification

- **Prove the regression test detects the regression.** For a reproduced bug,
  run the new assertion against the unfixed implementation when practical, then
  against the fix. The expected failure must be the defect, not setup errors or
  timeouts. Inspect historical code read-only or in a disposable copy; never
  reset user work for this proof. If pre-fix reproduction is unavailable, record
  that gap rather than treating a green new test as proven protection.
- **Gate on the condition, never on a fixed sleep.** Poll with a timeout and
  report the live value at failure time. Treat a check that passes on re-run as
  a bug in the check, not as noise.
- **Know what each check cannot see.** `npm test` is offline: it never talks to
  LeetCode or Cloudflare, never runs inside a real VS Code extension host, and
  never loads the browser extension in a real browser. State which of those
  surfaces a change touched and whether it was exercised.
- **Local check load.** Use the narrowest check that covers the edit, and rerun
  a check only when something it covers has changed — but never skip a check
  the change requires.

### Live LeetCode and browser checks

- Keep live LeetCode checks minimal, read-only where possible, and rate-limited;
  repeatable coverage belongs in offline fixtures. Bursts trigger Cloudflare
  challenges (see "Request And Cloudflare Notes" in the maintainer guide). Never
  automate a CAPTCHA or Cloudflare challenge; if bot detection blocks progress,
  pause for the user to clear it in their own browser.
- Prefer the user's existing browser profile and synced session for live
  reproduction. Real-browser and VS Code checks must not steal focus, switch the
  user's Space, or cover their active work; never close the user's existing
  browser or VS Code windows as cleanup. Tear down every browser, profile, or
  helper process a check launches, even on failure.
- State whether verification ran hidden or visible and what it could not
  establish (focus, notifications, onscreen behavior).

### UX bar

Hold user-facing changes (notifications, progress, webviews, the browser
extension popup/options) to the clarity and restraint a senior Apple product
designer would expect: one obvious primary action per prompt, plain language,
failure messages users can act on, sensible defaults over new settings, never
trap or surprise the user, and keep consequential actions explicit and
cancellable. Prefer native VS Code affordances (notifications, progress,
quick picks) over custom UI.

## Build & test

- `npm run compile` — type-check + emit (`tsc -p ./`).
- `npm test` — compiles `tsconfig.test.json` then runs the **offline** unit suite
  (mappers, renderer/XSS cases, solution-file round-trips). Must stay green.
- Integration tests (`src/test/integration/*.live.ts`) hit the live LeetCode API
  and need a real synced session; they are not part of `npm test`.

## Audit history

- `docs/maintainer-guide.md` has the consolidated audit notes, current caveats,
  live-test workflow, and release workflow.

When you finish an audit, append concise findings to `docs/maintainer-guide.md`
unless the audit is large enough to justify a separate file. Note fixes in
`CHANGELOG.md`.

## Known intentional design decisions — do NOT flag as bugs

These have been reviewed and are deliberate. Re-raising them as defects is noise;
if you believe one is now wrong, argue the *change*, don't list it as a finding.

### 1. The auth-sync HTTP listener accepts no-`Origin` POSTs without a secret (audit 2 / A2-2)

`src/auth/authSyncServer.ts` runs a loopback-only listener (`127.0.0.1`) that the
companion browser extension pushes the LeetCode session cookie to. By design:

- `leetcode.authSync.secret` is **empty by default** ("zero-config local sync"),
  so a request with no `Origin` header is accepted on the strength of carrying a
  valid `LEETCODE_SESSION` cookie.
- Cross-site browser requests are still rejected (the `Origin` allow-list blocks
  any web page, which always sends `Origin` on cross-origin POSTs), and CORS
  responses are only reflected to extension/loopback origins.

The residual exposure — *another local process* on the same machine could POST a
cookie — is an accepted trade-off for zero-config UX. The mitigation is offered,
not forced: users who don't trust local processes set `leetcode.authSync.secret`
(and the extension echoes it via `X-LeetCode-AuthSync-Secret`). **Do not** propose
making the secret mandatory or auto-generating one as a "fix"; treat the secret as
the documented opt-in security boundary.

### 2. `vscode://…?cookie=` URI sign-in ingests a cookie from the deep link (audit 2 / A2-3)

`leetCodeManager.handleUriSignIn` (the "Web Authorization" sign-in option) reads
the cookie from the URI query and signs in with it. This is the legacy web-auth
flow and is intentionally retained alongside auto-sync and manual cookie entry.
The deep-link prompt VS Code shows before invoking the handler is the accepted
user-consent gate. **Do not** flag this as login-CSRF/session-fixation to be
removed; it's a known, opt-in path.

## When auditing, these ARE fair game

Everything else — credential-at-rest handling, the request/HTTP layer, the
webview CSPs and sanitizer, explorer caching, concurrency in the sync server —
is in scope. See `docs/maintainer-guide.md` and `CHANGELOG.md` for current
state.

## Conventions

- `leetcode.cn` support is currently **broken and untested**; CN-only gaps are
  documented, not necessarily fixed. PRs welcome.
- Secrets (session cookie, captured browser request headers) live in
  `context.secrets` (OS keychain), never in `globalState`/Memento. Keep it that way.
