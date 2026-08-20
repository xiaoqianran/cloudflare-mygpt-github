# cloudflare-mygpt-github

A small Cloudflare Worker that gives a Custom GPT safe, explicit GitHub read/write tools without exposing a GitHub token to the GPT.

## v0.1 endpoints

- `GET /health` — public health check
- `GET /openapi.json` — OpenAPI 3.1 schema for GPT Actions
- `POST /v1/tree` — list repository tree
- `POST /v1/files/read` — read a UTF-8 file
- `POST /v1/branches` — create a `mygpt/*` working branch
- `POST /v1/commit` — atomically commit multiple file changes with Git Data API
- `POST /v1/pulls` — create a pull request (draft by default)

Safety defaults:

- only repositories matching `ALLOWED_REPOS` are accessible
- direct writes to `main` / `master` are blocked
- writes must target `mygpt/*`
- ref updates are non-force fast-forwards
- `expected_head_sha` provides optimistic concurrency protection
- GitHub and GPT API keys stay in Cloudflare Secrets

## Deploy

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npm test
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GPT_API_KEY
npm run deploy
```

Use a **fine-grained GitHub PAT** scoped only to the repositories this gateway should access. For the v0.1 feature set, grant repository `Contents: Read and write` and `Pull requests: Read and write`.

The default repository policy is configured in `wrangler.jsonc`:

```json
{
  "vars": {
    "ALLOWED_REPOS": "xiaoqianran/*",
    "WRITE_BRANCH_PREFIX": "mygpt/"
  }
}
```

For tighter security, replace `xiaoqianran/*` with explicit comma-separated repositories.

## Test after deploy

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"
export GPT_API_KEY="your-gateway-key"

curl "$BASE_URL/health"

curl -s "$BASE_URL/v1/tree" \
  -H "X-API-Key: $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"xiaoqianran/cloudflare-mygpt-github","ref":"main"}'
```

## Configure a Custom GPT

1. Open **GPTs → Create → Configure → Actions**.
2. Import `https://<your-worker>/openapi.json`.
3. Configure API-key authentication with header `X-API-Key` and the same value as the Worker secret `GPT_API_KEY`.
4. In your GPT instructions, tell it to read first, create a `mygpt/*` branch for changes, commit there, then open a PR.

The GPT never receives `GITHUB_TOKEN`; only the Worker can call GitHub.

## Example write flow

```text
listRepositoryTree
  -> readGitHubFile
  -> createGitHubBranch
  -> commitGitHubChanges
  -> createGitHubPullRequest
```

`POST /v1/commit` accepts multiple changes and produces one Git commit:

```json
{
  "repo": "xiaoqianran/example",
  "branch": "mygpt/fix-readme",
  "message": "docs: update README",
  "changes": [
    { "path": "README.md", "content": "# Updated\n" },
    { "path": "old.txt", "delete": true }
  ]
}
```

## Local tests

Tests use Node's built-in test runner and mock GitHub's HTTP API, so they do not need a real GitHub token:

```bash
npm test
```
