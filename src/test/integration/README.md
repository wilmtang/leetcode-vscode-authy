# Live integration tests

These tests exercise the real LeetCode API (`src/request/leetcode-api.ts`) with a
genuine signed-in session, so they catch breakage that the offline unit tests
cannot — Cloudflare behavior, GraphQL schema drift, auth/CSRF handling.

They **self-skip** when no auth fixture is present, so `npm test` stays offline
and green for everyone. They only run via `npm run test:integration`.

## 1. Capture a fixture from the browser extension

1. Open the LeetCode Auth Sync browser extension's **Settings** and enable
   **Developer mode**.
2. Make sure you're signed in to leetcode.com, then **refresh any leetcode.com
   page** (this lets the extension capture the full Cloudflare/browser headers).
3. Open the extension **popup** → **Developer** → **Copy test fixture**.

The copied JSON has this shape (see [`auth-fixture.example.json`](./auth-fixture.example.json)):

```json
{
  "endpoint": "leetcode",
  "cookie": "LEETCODE_SESSION=...; csrftoken=...",
  "userAgent": "Mozilla/5.0 ...",
  "requestHeaders": { "accept": "*/*", "sec-ch-ua-platform": "\"macOS\"" }
}
```

## 2. Paste it into the local-only fixture file

Create `src/test/.secrets/leetcode-auth.local.json` and paste the JSON there.
The directory is committed with an empty `leetcode-auth.local.example.json`
placeholder; keep real cookies in the `.local.json` file only.

```
src/test/.secrets/leetcode-auth.local.json
```

This path is **gitignored** (`src/test/.secrets/` and `*.local.json`), so it
cannot be committed by an ordinary `git add`. You can also point at a different
file with the `LEETCODE_AUTH_FIXTURE` environment variable.

> ⚠️ The fixture contains your live LeetCode login. Treat it like a password.
> Turning off Developer mode in the extension wipes its captured copy.

## 3. Run the tests

```bash
npm run test:integration
```

Without a fixture you'll see the suite reported as skipped.

## Extra protection against committing secrets

`.gitignore` is the primary guard. For defense-in-depth, opt into a pre-commit
hook that blocks any staged `*.local.json`, anything under `.secrets/`, or any
diff containing a `LEETCODE_SESSION` token:

```bash
npm run local -- hooks
```

This sets `core.hooksPath` to `scripts/git-hooks` for this repo. Bypass a false
positive with `git commit --no-verify`.
