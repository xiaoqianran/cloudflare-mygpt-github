# Cloudflare Free-Tier Cache Policy

v0.7.0 keeps repository access unrestricted while treating D1/R2 as a bounded cache.

Defaults in `wrangler.jsonc`:

```text
MAX_MIRROR_FILE_BYTES   = 524288       # 512 KiB per file
MAX_INDEX_CHARS         = 20000        # D1 FTS prefix per file
MAX_REPO_MIRROR_BYTES   = 300000000    # ~300 MB logical cache per repo
MAX_TOTAL_MIRROR_BYTES  = 8000000000   # 8 GB logical cache target
MIRROR_TTL_DAYS         = 7            # idle third-party mirror TTL
PINNED_REPOS            = xiaoqianran/*
R2_GC_MAX_OBJECTS       = 500           # orphan objects scanned per daily run
```

Behavior:

- Any GitHub repository may still be synchronized (`ALLOWED_REPOS=*`).
- `xiaoqianran/*` mirrors are pinned and are not TTL/LRU-evicted.
- Other repositories are removed after 7 days without access.
- Repository access updates `last_accessed_at` at most once every 6 hours to reduce D1 writes.
- After every Queue chunk, repositories above the per-repo budget have the largest cached files evicted first.
- A daily Cron Trigger evicts stale repositories, enforces the global cache target, and removes orphaned `blobs/<sha>` objects from R2.
- Files removed from R2 by the cache budget remain readable through `readFiles`, which falls back to GitHub.

## Upgrade

```bash
git pull
npm install
npm run deploy
```

`npm run deploy` applies pending D1 migrations before deploying the Worker. For the first-ever deployment use `npm run setup`.
