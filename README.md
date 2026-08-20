# cloudflare-mygpt-github

Cloudflare gateway for fast Custom GPT access to GitHub repositories.

The core v0.5 design is a **repository mirror**:

```text
GitHub
  │
  │ initial / incremental sync
  ▼
Cloudflare Worker
  ├─ D1: repository manifest + FTS5 search index
  ├─ R2: immutable Git blob text cache
  └─ Queue: asynchronous sync workers
        │
        ▼
Custom GPT
```

After the first sync, normal GPT reads and searches no longer need GitHub API calls.

Native Git Smart HTTP remains available as a separate optional data plane for local `clone/fetch/pull/push`.

## Why v0.5

The old flow was still:

```text
Custom GPT -> Worker -> GitHub API
```

That removed ChatGPT's built-in GitHub connector, but large repository work could still be dominated by GitHub API latency and rate limits.

v0.5 changes the hot path to:

```text
Custom GPT -> Worker -> D1 / R2
```

GitHub is used mainly when synchronizing a repository or writing changes.

## GPT actions

Import:

```text
https://<your-worker>/openapi.json
```

Authentication:

```text
API Key -> Bearer
```

Use the same value stored in Cloudflare as `GPT_API_KEY`.

Actions:

- `syncRepository` — queue an asynchronous repository mirror refresh
- `inspectRepository` — read repository metadata/tree from D1
- `readFiles` — batch-read mirrored text files from R2
- `searchRepository` — search the D1 FTS5 index instead of GitHub Code Search
- `readRepositoryPage` — progressively traverse the entire mirrored text repository under a context budget
- `applyChanges` — write changes back to GitHub

Recommended GPT instruction:

```text
For GitHub tasks, call inspectRepository first. If the mirror is missing or stale, call syncRepository and inspect again until it is ready. Use searchRepository and readFiles for targeted work. For a whole-repository review, repeatedly call readRepositoryPage using next_cursor until it is null. Do not use GitHub directly when the mirror can answer the request.
```

## Mirror lifecycle

First sync:

```text
syncRepository
    │
    ▼
Queue manifest job
    │
    ├─ fetch repo metadata
    ├─ fetch one recursive Git tree
    ├─ compare path/blob SHA against D1
    └─ queue only files that need content
             │
             ▼
      batched GitHub GraphQL Blob reads
             │
             ├─ R2: blobs/<git-blob-sha>
             ├─ D1: mirror_files manifest
             └─ D1 FTS5: searchable text prefix
```

On later syncs, unchanged paths whose Git blob SHA is already cached are skipped. A repository with 2,000 files but only 8 changed files therefore normally fetches content for only those changed files.

The mirror is content-addressed by Git blob SHA, so immutable file content can be reused safely.

### Whole-repository traversal

`readRepositoryPage` returns a deterministic page of source content plus `next_cursor`.

Keep calling it until:

```json
{"next_cursor": null}
```

The cursor also contains an offset, so a single large source file can continue across multiple GPT action calls without losing content.

This does not mean the entire repository is injected into one model context. It means GPT can walk every mirrored source file as quickly as its context budget allows, without repeatedly hitting GitHub.

## Storage policy

Defaults in `wrangler.jsonc`:

```jsonc
"MAX_MIRROR_FILE_BYTES": "1000000",
"MAX_INDEX_CHARS": "120000"
```

- text files up to 1 MB are eligible for the R2 mirror
- the first 120k characters of each mirrored text file are indexed in D1 FTS5
- full mirrored file text remains in R2
- binary/oversized/cache-miss reads can fall back to GitHub when explicitly requested through `readFiles`

If GitHub's recursive tree reports truncation, the mirror is marked `partial` and old manifest entries are not deleted.

## Cloudflare resources

v0.5 uses three bindings:

```text
REPO_DB          D1
REPO_BLOBS       R2
REPO_SYNC_QUEUE  Queue
```

Wrangler 4.45+ supports automatic resource provisioning for D1/R2, and current Wrangler also supports automatic provisioning for Queues. The repository therefore does not contain account-specific resource IDs.

## First deployment / upgrade

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npm test
npx wrangler login
```

Secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GPT_API_KEY
npx wrangler secret put GIT_GATEWAY_TOKEN
```

`GIT_GATEWAY_TOKEN` is only needed if you use the native Git bridge.

For the first v0.5 deployment run:

```bash
npm run setup
```

`setup` performs:

```text
wrangler deploy
  -> auto-provisions/binds D1 + R2 + Queue

wrangler d1 migrations apply REPO_DB --remote
  -> creates repository mirror tables + FTS5 index
```

After that, normal updates use:

```bash
npm run deploy
```

If Wrangler writes provisioned D1/R2 identifiers back into your local `wrangler.jsonc`, that is expected. Do not manually invent resource IDs.

## First repository sync

After deployment, configure the Custom GPT Action schema again from `/openapi.json`, then ask the GPT to sync a repository.

Equivalent API call:

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"

curl -s "$BASE_URL/v1/repository/sync" \
  -H "Authorization: Bearer $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"xiaoqianran/cloudflare-mygpt-github"}'
```

The response is immediate and should contain `status: queued`.

Check progress:

```bash
curl -s "$BASE_URL/v1/repository/inspect" \
  -H "Authorization: Bearer $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"xiaoqianran/cloudflare-mygpt-github"}'
```

Expected states:

```text
missing -> queued -> syncing -> ready
```

`partial` means GitHub returned a truncated recursive tree. `error`/`last_error` exposes sync failures without exposing secrets.

## Native Git bridge

This remains separate from the GPT mirror:

```text
GET  /git/{owner}/{repo}.git/info/refs?service=git-upload-pack
POST /git/{owner}/{repo}.git/git-upload-pack
GET  /git/{owner}/{repo}.git/info/refs?service=git-receive-pack
POST /git/{owner}/{repo}.git/git-receive-pack
```

Example:

```bash
export GATEWAY_HOST="cloudflare-mygpt-github.<your-subdomain>.workers.dev"
git clone "https://git@${GATEWAY_HOST}/git/xiaoqianran/cloudflare-mygpt-github.git"
```

Use `GIT_GATEWAY_TOKEN` as the HTTP Basic password. Native Git is intentionally transparent after authentication; GitHub token permissions and GitHub repository rules determine what pushes are accepted.

## Secrets and trust boundaries

```text
GPT_API_KEY
  Custom GPT -> Worker only

GIT_GATEWAY_TOKEN
  Local Git -> Worker only

GITHUB_TOKEN
  Worker -> GitHub only
```

Never put `GITHUB_TOKEN` into a Custom GPT or local Git remote URL.
