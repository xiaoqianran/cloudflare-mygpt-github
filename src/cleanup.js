import { matchesRepoPattern } from "./policy.js";

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_REPO_BYTES = 300_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 8_000_000_000;
const DEFAULT_GC_OBJECTS = 500;
const DEFAULT_EXPIRE_REPOS = 20;
const TOUCH_INTERVAL_HOURS = 6;

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function repoPatterns(value = "") {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function isPinnedRepository(env, repo) {
  return repoPatterns(env.PINNED_REPOS || "").some((pattern) => matchesRepoPattern(repo, pattern));
}

export async function touchRepository(env, repo) {
  if (!env.REPO_DB || typeof repo !== "string" || !repo) return;
  await env.REPO_DB.prepare(
    `UPDATE repositories
        SET last_accessed_at = CURRENT_TIMESTAMP
      WHERE repo = ?
        AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', ?))`,
  ).bind(repo, `-${TOUCH_INTERVAL_HOURS} hours`).run();
}

async function cachedBytes(env, repo = null) {
  const row = repo
    ? await env.REPO_DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM mirror_files WHERE repo = ? AND cached = 1`,
    ).bind(repo).first()
    : await env.REPO_DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM mirror_files WHERE cached = 1`,
    ).first();
  return Number(row?.bytes || 0);
}

async function deleteR2IfOrphan(env, sha) {
  const ref = await env.REPO_DB.prepare(
    `SELECT 1 AS found FROM mirror_files WHERE blob_sha = ? AND cached = 1 LIMIT 1`,
  ).bind(sha).first();
  if (!ref) await env.REPO_BLOBS.delete(`blobs/${sha}`);
}

async function uncachePath(env, repo, path, sha) {
  await env.REPO_DB.batch([
    env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(repo, path),
    env.REPO_DB.prepare(
      `UPDATE mirror_files
          SET cached = 0, is_indexed = 0, updated_at = CURRENT_TIMESTAMP
        WHERE repo = ? AND path = ? AND blob_sha = ?`,
    ).bind(repo, path, sha),
  ]);
  await deleteR2IfOrphan(env, sha);
}

export async function enforceRepositoryBudget(env, repo) {
  if (!env.REPO_DB || !env.REPO_BLOBS || !repo) return { repo, removed: 0, bytes: 0 };
  const limit = positiveInt(env.MAX_REPO_MIRROR_BYTES, DEFAULT_MAX_REPO_BYTES);
  let total = await cachedBytes(env, repo);
  if (total <= limit) return { repo, removed: 0, bytes: total, limit };

  const result = await env.REPO_DB.prepare(
    `SELECT path, blob_sha, size
       FROM mirror_files
      WHERE repo = ? AND cached = 1
      ORDER BY size DESC, path DESC`,
  ).bind(repo).all();

  let removed = 0;
  for (const file of result.results || []) {
    if (total <= limit) break;
    await uncachePath(env, repo, file.path, file.blob_sha);
    total -= Number(file.size || 0);
    removed += 1;
  }

  return { repo, removed, bytes: Math.max(total, 0), limit };
}

async function deleteRepository(env, repo) {
  const shaResult = await env.REPO_DB.prepare(
    `SELECT DISTINCT blob_sha FROM mirror_files WHERE repo = ? AND cached = 1 LIMIT 5000`,
  ).bind(repo).all();
  const state = await env.REPO_DB.prepare(`SELECT sync_id FROM repositories WHERE repo = ?`).bind(repo).first();
  const logicalBytes = await cachedBytes(env, repo);

  const statements = [
    env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ?`).bind(repo),
    env.REPO_DB.prepare(`DELETE FROM mirror_files WHERE repo = ?`).bind(repo),
    env.REPO_DB.prepare(`DELETE FROM repositories WHERE repo = ?`).bind(repo),
  ];
  if (state?.sync_id) statements.push(env.REPO_DB.prepare(`DELETE FROM sync_batches WHERE sync_id = ?`).bind(state.sync_id));
  await env.REPO_DB.batch(statements);

  for (const row of shaResult.results || []) await deleteR2IfOrphan(env, row.blob_sha);
  return logicalBytes;
}

async function expireIdleRepositories(env) {
  const ttlDays = positiveInt(env.MIRROR_TTL_DAYS, DEFAULT_TTL_DAYS);
  const limit = positiveInt(env.MAX_EXPIRE_REPOS_PER_RUN, DEFAULT_EXPIRE_REPOS);
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  const result = await env.REPO_DB.prepare(
    `SELECT repo
       FROM repositories
      WHERE status NOT IN ('queued', 'syncing')
        AND COALESCE(last_accessed_at, synced_at, sync_started_at, '1970-01-01T00:00:00.000Z') < ?
      ORDER BY COALESCE(last_accessed_at, synced_at, sync_started_at) ASC
      LIMIT ?`,
  ).bind(cutoff, limit).all();

  let removed = 0;
  let freedLogicalBytes = 0;
  for (const row of result.results || []) {
    if (isPinnedRepository(env, row.repo)) continue;
    freedLogicalBytes += await deleteRepository(env, row.repo);
    removed += 1;
  }
  return { ttl_days: ttlDays, removed, freed_logical_bytes: freedLogicalBytes };
}

async function enforceTotalBudget(env) {
  const limit = positiveInt(env.MAX_TOTAL_MIRROR_BYTES, DEFAULT_MAX_TOTAL_BYTES);
  let total = await cachedBytes(env);
  if (total <= limit) return { removed_repositories: 0, bytes: total, limit };

  const result = await env.REPO_DB.prepare(
    `SELECT repo
       FROM repositories
      WHERE status NOT IN ('queued', 'syncing')
      ORDER BY COALESCE(last_accessed_at, synced_at, sync_started_at, '1970-01-01T00:00:00.000Z') ASC
      LIMIT 100`,
  ).all();

  let removedRepositories = 0;
  for (const row of result.results || []) {
    if (total <= limit) break;
    if (isPinnedRepository(env, row.repo)) continue;
    total -= await deleteRepository(env, row.repo);
    removedRepositories += 1;
  }
  return { removed_repositories: removedRepositories, bytes: Math.max(total, 0), limit };
}

async function gcOrphanBlobs(env) {
  const maxObjects = positiveInt(env.R2_GC_MAX_OBJECTS, DEFAULT_GC_OBJECTS);
  let cursor;
  let scanned = 0;
  let deleted = 0;

  while (scanned < maxObjects) {
    const page = await env.REPO_BLOBS.list({
      prefix: "blobs/",
      limit: Math.min(250, maxObjects - scanned),
      ...(cursor ? { cursor } : {}),
    });
    const objects = page.objects || [];
    if (!objects.length) break;
    scanned += objects.length;

    for (let offset = 0; offset < objects.length; offset += 50) {
      const group = objects.slice(offset, offset + 50);
      const shas = group.map((object) => object.key.slice("blobs/".length));
      const placeholders = shas.map(() => "?").join(",");
      const refs = await env.REPO_DB.prepare(
        `SELECT DISTINCT blob_sha FROM mirror_files WHERE cached = 1 AND blob_sha IN (${placeholders})`,
      ).bind(...shas).all();
      const referenced = new Set((refs.results || []).map((row) => row.blob_sha));
      const orphanKeys = group.filter((object) => !referenced.has(object.key.slice("blobs/".length))).map((object) => object.key);
      if (orphanKeys.length) {
        await env.REPO_BLOBS.delete(orphanKeys);
        deleted += orphanKeys.length;
      }
    }

    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return { scanned, deleted };
}

export async function runMirrorMaintenance(env) {
  if (!env.REPO_DB || !env.REPO_BLOBS) return { skipped: true, reason: "mirror bindings are missing" };
  const expired = await expireIdleRepositories(env);
  const total_budget = await enforceTotalBudget(env);
  const r2_gc = await gcOrphanBlobs(env);
  return { skipped: false, expired, total_budget, r2_gc };
}
