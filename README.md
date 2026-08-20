# cloudflare-mygpt-github

A Cloudflare Worker gateway that lets a Custom GPT safely read and modify allowed GitHub repositories without exposing the GitHub token to ChatGPT.

## Architecture

```text
Custom GPT
   │  X-API-Key: GPT_API_KEY
   ▼
Cloudflare Worker
   ├─ auth
   ├─ repository allowlist
   ├─ path/branch policy
   ├─ GPT-optimized actions
   └─ GitHub API client
          │  GITHUB_TOKEN (Worker Secret only)
          ▼
        GitHub
```

The Worker deliberately exposes a very small action surface to the GPT:

- `inspectRepository` — metadata + repository tree
- `readFiles` — batch-read up to 20 files
- `searchCode` — repository-scoped GitHub code search
- `applyChanges` — create/reuse `mygpt/*`, atomically commit multiple files, and optionally create/reuse a PR

`GET /health` and `GET /openapi.json` remain public utility endpoints but are not exposed as GPT tools.

## Why v0.2

v0.2 replaces the original low-level branch/commit/PR action set with four higher-level operations. This reduces GPT tool calls, makes multi-file edits atomic, and keeps the security policy in the Worker instead of relying on model instructions.

The OpenAPI document is explicit OpenAPI 3.1 and always contains a real `components.schemas` object with named schemas and `$ref`s, matching the structure expected by Custom GPT Actions.

## Safety defaults

- only repositories matching `ALLOWED_REPOS` are accessible
- `GITHUB_TOKEN` never leaves Cloudflare Secrets
- direct writes to `main` / `master` are blocked
- writes must target `mygpt/*`
- `.env`, private keys and credential files cannot be read or written
- `.github/workflows/*` cannot be modified
- Git refs are updated with `force: false`
- `expected_head_sha` can guard against concurrent branch changes
- PRs are draft by default

## Deploy

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npm test
npx wrangler login

# Only required the first time or when rotating secrets:
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GPT_API_KEY

npm run deploy
```

Use a fine-grained GitHub PAT scoped only to the repositories this gateway should access. Grant repository `Contents: Read and write` and `Pull requests: Read and write`.

The default policy is in `wrangler.jsonc`:

```json
{
  "vars": {
    "ALLOWED_REPOS": "xiaoqianran/*",
    "WRITE_BRANCH_PREFIX": "mygpt/"
  }
}
```

For tighter security, replace `xiaoqianran/*` with explicit comma-separated repositories.

## Verify after deploy

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"
export GPT_API_KEY="your-gateway-key"

curl "$BASE_URL/health"

curl -s "$BASE_URL/openapi.json" | python -m json.tool

curl -s "$BASE_URL/v1/repository/inspect" \
  -H "X-API-Key: $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"xiaoqianran/cloudflare-mygpt-github"}'
```

## Configure Custom GPT

In **GPTs → Create → Configure → Actions**:

1. Import `https://<your-worker>/openapi.json`.
2. Authentication: **API Key → Custom**.
3. Header name: `X-API-Key`.
4. API key value: the same value stored in the Worker secret `GPT_API_KEY`.

Do **not** put `GITHUB_TOKEN` into ChatGPT.

Recommended GPT instruction:

```text
For GitHub work, use the gateway actions. Inspect/search first, batch-read the relevant files, then use applyChanges for edits. Never ask me to paste repository files when the actions can read them. Use a mygpt/* working branch and create a draft PR unless I explicitly ask not to.
```

## Typical edit flow

```text
inspectRepository
      ↓
searchCode (when useful)
      ↓
readFiles (batch)
      ↓
applyChanges
   ├─ create/reuse working branch
   ├─ one atomic Git commit
   └─ create/reuse draft PR
```

Example `applyChanges` request:

```json
{
  "repo": "xiaoqianran/example",
  "branch": "mygpt/fix-readme",
  "message": "docs: update README",
  "changes": [
    { "path": "README.md", "content": "# Updated\n" },
    { "path": "old.txt", "delete": true }
  ],
  "pull_request": {
    "title": "docs: update README",
    "draft": true
  }
}
```

Set `"create_pull_request": false` if you only want the commit.

## Updating from v0.1

No secret rotation is required. Pull the latest code and redeploy:

```bash
git pull
npm install
npm test
npm run deploy
```

Then remove the old Action schema in the Custom GPT and import `/openapi.json` again so ChatGPT sees the v0.2 operations.

## Tests

```bash
npm test
```

Tests mock GitHub HTTP calls and cover OpenAPI shape, authentication, allowlists, sensitive paths, repository inspection, batch reads, code search, atomic commits, draft PR creation and optimistic concurrency.
