# cloudflare-mygpt-github

A Cloudflare Worker gateway that gives Custom GPTs and local Git clients controlled access to allowed GitHub repositories without exposing the GitHub token to either client.

## v0.3 architecture

```text
                         GitHub
                           ▲
                           │ GITHUB_TOKEN
                           │ Cloudflare Secret only
                           │
                 ┌─────────┴─────────┐
                 │ Cloudflare Worker │
                 │                   │
                 │ policy / allowlist│
                 │ auth / streaming  │
                 └──────┬─────┬──────┘
                        │     │
          control plane │     │ data plane
                        │     │
              Bearer    │     │ HTTP Basic
             GPT_API_KEY│     │ GIT_GATEWAY_TOKEN
                        │     │
                 Custom GPT   Local Git
                              clone/fetch/pull
                              optional push
```

The important separation is intentional:

- **Custom GPT control plane** uses `Authorization: Bearer <GPT_API_KEY>` and four high-level JSON actions.
- **Native Git data plane** uses Git Smart HTTP under `/git/...` with HTTP Basic authentication. The Basic password is `GIT_GATEWAY_TOKEN`, never the GitHub PAT.
- **GitHub authentication** uses `GITHUB_TOKEN` only inside the Worker.

Your local machine only needs to resolve/reach the Cloudflare Worker. `git clone`, `git fetch`, and `git pull` are proxied and streamed by Cloudflare to GitHub, so the local Git client does not need to connect to `github.com`.

## Custom GPT actions

The Worker exposes only four GPT-facing tools:

- `inspectRepository` — metadata + repository tree
- `readFiles` — batch-read repository files
- `searchCode` — repository-scoped GitHub code search
- `applyChanges` — create/reuse `mygpt/*`, atomically commit multiple files, and optionally create/reuse a draft PR

`GET /health` and `GET /openapi.json` are public utility endpoints but are not GPT tools.

## Native Git bridge

Smart HTTP routes are deliberately separate from the GPT OpenAPI schema:

```text
GET  /git/{owner}/{repo}.git/info/refs?service=git-upload-pack
POST /git/{owner}/{repo}.git/git-upload-pack

GET  /git/{owner}/{repo}.git/info/refs?service=git-receive-pack
POST /git/{owner}/{repo}.git/git-receive-pack
```

### Clone / fetch / pull

These are supported by default and streamed end-to-end without buffering repository packfiles in Worker memory.

Example:

```bash
export GATEWAY_HOST="cloudflare-mygpt-github.<your-subdomain>.workers.dev"

git clone "https://git@${GATEWAY_HOST}/git/xiaoqianran/cloudflare-mygpt-github.git"
```

Git will ask for a password. Enter the value stored in Cloudflare as `GIT_GATEWAY_TOKEN`.

After cloning, all normal local operations are local and do not contact GitHub:

```bash
cd cloudflare-mygpt-github
git switch -c mygpt/local-change
# edit files
git add .
git commit -m "feat: local change"
```

`git fetch` / `git pull` continue to use the Worker because `origin` points at the gateway URL.

### Native `git push`

Push is implemented but **disabled by default**:

```jsonc
"ENABLE_GIT_PUSH": "false"
```

This is deliberate. When enabled, the Worker inspects the `git-receive-pack` command section before streaming the pack to GitHub and only permits updates to:

```text
refs/heads/mygpt/*
```

It blocks pushes to `main`, `master`, tags, other branches, and branch deletion.

To enable it, change `wrangler.jsonc` to:

```jsonc
"ENABLE_GIT_PUSH": "true"
```

then redeploy:

```bash
npm run deploy
```

Now a normal local push works:

```bash
git push -u origin mygpt/local-change
```

**Important:** the Git wire protocol does not mark a ref update as “force” in a way this streaming gateway can reliably distinguish without understanding the incoming pack graph. Therefore force-updating an allowed `mygpt/*` branch cannot be completely prevented at the Worker layer. Keep important branches protected on GitHub; `main/master` are already unreachable through this bridge because the Worker rejects those refs before forwarding the pack.

## Cloudflare limits

This architecture is a good fit for normal source repositories because Worker responses can be streamed without an enforced response-body limit. Native pushes are inbound requests, so Cloudflare account request-body limits still apply (for example, 100 MB on Free/Pro at the time of v0.3).

Consequences:

- clone/fetch of large normal repositories is much less constrained because the large pack travels in the response direction;
- a single native push whose HTTP request body exceeds your Cloudflare plan limit will fail before it reaches the Worker;
- Git LFS is not proxied in v0.3;
- submodules whose `.gitmodules` URLs point directly at GitHub will also bypass this gateway unless their URLs are rewritten.

For very large pushes/LFS, use a VPS/tunnel-based Git proxy rather than forcing that traffic through Workers.

## Safety defaults

- only repositories matching `ALLOWED_REPOS` are accessible
- `GITHUB_TOKEN` never leaves Cloudflare Secrets
- GPT actions use Bearer auth, not the GitHub token
- native Git uses a separate `GIT_GATEWAY_TOKEN`
- direct GPT writes to `main` / `master` are blocked
- GPT writes must target `mygpt/*`
- native Git push, when enabled, may only update `mygpt/*`
- `.env`, private keys, and credential files cannot be read/written through GPT actions
- `.github/workflows/*` cannot be modified through GPT actions
- GPT Git ref updates use `force: false`
- `expected_head_sha` can guard GPT writes against concurrent branch changes
- GPT-created PRs are draft by default

## Deploy / upgrade

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npm test
npx wrangler login
```

Configure secrets:

```bash
# GitHub PAT: only Cloudflare knows this
npx wrangler secret put GITHUB_TOKEN

# Custom GPT -> Worker Bearer token
npx wrangler secret put GPT_API_KEY

# Native Git -> Worker Basic-auth password
npx wrangler secret put GIT_GATEWAY_TOKEN
```

Deploy:

```bash
npm run deploy
```

Use a fine-grained GitHub PAT scoped only to repositories this gateway should access. For the current feature set, use repository `Contents: Read and write` and `Pull requests: Read and write`.

Default policy in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "ALLOWED_REPOS": "xiaoqianran/*",
    "WRITE_BRANCH_PREFIX": "mygpt/",
    "ENABLE_GIT_PUSH": "false"
  }
}
```

For tighter security, replace `xiaoqianran/*` with explicit comma-separated repositories.

## Verify after deploy

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"

curl "$BASE_URL/health"
```

Expected version:

```json
{"ok":true,"service":"cloudflare-mygpt-github","version":"0.3.0"}
```

Verify the GPT control plane:

```bash
curl -s "$BASE_URL/v1/repository/inspect" \
  -H "Authorization: Bearer $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"xiaoqianran/cloudflare-mygpt-github"}'
```

Verify native Git without cloning the whole repository:

```bash
GIT_TRACE_CURL=1 git ls-remote \
  "https://git@${BASE_URL#https://}/git/xiaoqianran/cloudflare-mygpt-github.git"
```

Use `GIT_GATEWAY_TOKEN` when Git prompts for the password.

## Configure Custom GPT

In **GPTs → Create → Configure → Actions**:

1. Import `https://<your-worker>/openapi.json`.
2. Authentication: **API Key → Bearer**.
3. API key value: the same value stored in `GPT_API_KEY`.

Do **not** put `GITHUB_TOKEN` or `GIT_GATEWAY_TOKEN` into the Custom GPT.

Recommended instruction:

```text
For GitHub work, use the gateway actions. Inspect/search first, batch-read the relevant files, then use applyChanges for edits. Never ask me to paste repository files when the actions can read them. Use a mygpt/* working branch and create a draft PR unless I explicitly ask not to.
```

## Why the hybrid design

A pure GitHub REST gateway is excellent for GPT Actions but cannot create a real local `.git` checkout. A completely transparent Git reverse proxy gives native Git semantics but weakens policy control over writes. v0.3 uses both:

- **high-level JSON actions** where safety and deterministic AI behavior matter;
- **streaming Smart HTTP** where native Git protocol compatibility matters;
- native push remains opt-in and restricted to disposable `mygpt/*` branches.

That keeps the gateway small while preserving both AI-agent workflows and real local Git workflows.
