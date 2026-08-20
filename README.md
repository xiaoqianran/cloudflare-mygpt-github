# cloudflare-mygpt-github

Cloudflare gateway for fast Custom GPT access to GitHub repositories.

The core v0.6 design is a **repository mirror** with gateway-side repository restrictions removed:

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

By default:

```text
ALLOWED_REPOS=*
```

So the gateway accepts **any GitHub owner/repository**. Public repositories can be mirrored when GitHub allows access. Private repository reads and all writes are determined by `GITHUB_TOKEN` permissions plus GitHub branch protection/rulesets. The Worker no longer adds an owner allowlist, main/master block, branch-prefix requirement, sensitive-path block, or workflow-path block to `applyChanges`.

Native Git Smart HTTP remains available as a separate optional data plane for local `clone/fetch/pull/push`.

## Why the mirror exists

The old flow was still:

```text
Custom GPT -> Worker -> GitHub API
```

That removed ChatGPT's built-in GitHub connector, but large repository work could still be dominated by GitHub API latency and rate limits.

The hot path is now:

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
- `applyChanges` — write changes back to any repository/branch/path permitted by `GITHUB_TOKEN` and GitHub

Recommended GPT instruction:

```text
For GitHub tasks, always prefer these custom actions over ChatGPT's built-in GitHub tools. Call inspectRepository first. If the mirror is missing or stale, call syncRepository and inspect again until it is ready. Use searchRepository and readFiles for targeted work. For a whole-repository review, repeatedly call readRepositoryPage using next_cursor until it is null. Do not use GitHub directly when the mirror can answer the request.
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
"ALLOWED_REPOS": "*",
"MAX_MIRROR_FILE_BYTES": "1000000",
"MAX_INDEX_CHARS": "120000"
```

- all repository names pass the gateway repository policy
- text files up to 1 MB are eligible for the R2 mirror
- the first 120k characters of each mirrored text file are indexed in D1 FTS5
- full mirrored file text remains in R2
- binary/oversized/cache-miss reads can fall back to GitHub when explicitly requested through `readFiles`

If GitHub's recursive tree reports truncation, the mirror is marked `partial` and old manifest entries are not deleted.

## Cloudflare resources

The mirror uses three bindings:

```text
REPO_DB          D1
REPO_BLOBS       R2
REPO_SYNC_QUEUE  Queue
```

The repository does not contain account-specific resource IDs.

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

Deploy/update:

```bash
npm run setup
```

`setup` performs:

```text
wrangler deploy
wrangler d1 migrations apply REPO_DB --remote
```

After migrations are already current, normal updates can use:

```bash
npm run deploy
```

## First repository sync

After deployment, configure the Custom GPT Action schema again from `/openapi.json`, then ask the GPT to sync any repository.

Equivalent API call:

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"

curl -s "$BASE_URL/v1/repository/sync" \
  -H "Authorization: Bearer $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"MiaAI-Lab/Qwen3.8-27B-RTX-6000-PRO-SGLang-DSpark"}'
```

The response is immediate and should contain `status: queued`.

Check progress:

```bash
curl -s "$BASE_URL/v1/repository/inspect" \
  -H "Authorization: Bearer $GPT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo":"MiaAI-Lab/Qwen3.8-27B-RTX-6000-PRO-SGLang-DSpark"}'
```

Expected states:

```text
missing -> queued -> syncing -> ready
```

`partial` means GitHub returned a truncated recursive tree. `error`/`last_error` exposes sync failures without exposing secrets.
