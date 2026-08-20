import { HttpError } from "./errors.js";
import { github, encodeRepoPath, decodeBase64Utf8 } from "./github.js";
import { normalizeRepo, assertRepoAllowed, validateReadPaths } from "./policy.js";

const DEFAULT_MAX_MIRROR_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_INDEX_CHARS = 120_000;
const BLOB_BATCH_SIZE = 20;
const SQL_BATCH_SIZE = 80;
const QUEUE_SEND_BATCH_SIZE = 100;

function requireMirrorBindings(env, { queue = false } = {}) {
  if (!env.REPO_DB) throw new HttpError(503, "REPO_DB binding is not configured");
  if (!env.REPO_BLOBS) throw new HttpError(503, "REPO_BLOBS binding is not configured");
  if (queue && !env.REPO_SYNC_QUEUE) throw new HttpError(503, "REPO_SYNC_QUEUE binding is not configured");
}

function maxMirrorBytes(env) {
  const value = Number(env.MAX_MIRROR_FILE_BYTES || DEFAULT_MAX_MIRROR_FILE_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_MIRROR_FILE_BYTES;
}

function maxIndexChars(env) {
  const value = Number(env.MAX_INDEX_CHARS || DEFAULT_MAX_INDEX_CHARS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_INDEX_CHARS;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function r2Key(sha) {
  return `blobs/${sha}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function getRepositoryRow(env, repo) {
  return env.REPO_DB.prepare(
    `SELECT repo, ref, head_sha, default_branch, status, sync_id, pending_batches,
            file_count, mirrored_file_count, total_bytes, sync_started_at, synced_at, last_error
       FROM repositories WHERE repo = ?`,
  ).bind(repo).first();
}

export async function startMirrorSync(env, input) {
  requireMirrorBindings(env, { queue: true });
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
  const syncId = crypto.randomUUID();
  const startedAt = nowIso();

  await env.REPO_DB.batch([
    env.REPO_DB.prepare(
      `INSERT INTO repositories
         (repo, ref, status, sync_id, pending_batches, sync_started_at, last_error)
       VALUES (?, ?, 'queued', ?, 0, ?, NULL)
       ON CONFLICT(repo) DO UPDATE SET
         ref = excluded.ref,
         status = 'queued',
         sync_id = excluded.sync_id,
         pending_batches = 0,
         sync_started_at = excluded.sync_started_at,
         last_error = NULL`,
    ).bind(repo, ref || "@default", syncId, startedAt),
    env.REPO_DB.prepare(
      `INSERT OR REPLACE INTO sync_batches(sync_id, batch_id, status, completed_at)
       VALUES (?, '__manifest__', 'pending', NULL)`,
    ).bind(syncId),
  ]);

  try {
    await env.REPO_SYNC_QUEUE.send({ type: "manifest", repo, ref, sync_id: syncId });
  } catch (error) {
    await env.REPO_DB.prepare(
      `UPDATE repositories SET status = 'error', last_error = ? WHERE repo = ? AND sync_id = ?`,
    ).bind(error instanceof Error ? error.message : "queue send failed", repo, syncId).run();
    throw error;
  }

  return { repo, ref: ref || null, sync_id: syncId, status: "queued" };
}

export async function inspectMirror(env, input) {
  requireMirrorBindings(env);
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const row = await getRepositoryRow(env, repo);
  if (!row) {
    return { repo, status: "missing", ready: false, items: [], hint: "Call syncRepository once to build the mirror." };
  }

  const prefix = typeof input.path === "string" && input.path
    ? input.path.replace(/^\/+|\/+$/g, "")
    : "";
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 2000) : 500;
  const like = prefix ? `${prefix}/%` : "%";
  const exact = prefix || "";
  const query = prefix
    ? `SELECT path, blob_sha AS sha, size, cached, is_binary, is_indexed
         FROM mirror_files
        WHERE repo = ? AND (path = ? OR path LIKE ?)
        ORDER BY path LIMIT ?`
    : `SELECT path, blob_sha AS sha, size, cached, is_binary, is_indexed
         FROM mirror_files
        WHERE repo = ? ORDER BY path LIMIT ?`;
  const stmt = prefix
    ? env.REPO_DB.prepare(query).bind(repo, exact, like, limit)
    : env.REPO_DB.prepare(query).bind(repo, limit);
  const result = await stmt.all();

  return {
    repo,
    ref: row.ref === "@default" ? null : row.ref,
    head_sha: row.head_sha,
    default_branch: row.default_branch,
    status: row.status,
    ready: row.status === "ready",
    sync_id: row.sync_id,
    pending_batches: row.pending_batches,
    file_count: row.file_count,
    mirrored_file_count: row.mirrored_file_count,
    total_bytes: row.total_bytes,
    sync_started_at: row.sync_started_at,
    synced_at: row.synced_at,
    last_error: row.last_error,
    items: result.results || [],
    truncated: (result.results || []).length >= limit,
  };
}

async function readOneMirrorFile(env, repo, path, requestedRef) {
  const row = await env.REPO_DB.prepare(
    `SELECT f.path, f.blob_sha, f.size, f.cached, f.is_binary, r.ref, r.head_sha, r.status
       FROM mirror_files f JOIN repositories r ON r.repo = f.repo
      WHERE f.repo = ? AND f.path = ?`,
  ).bind(repo, path).first();

  const refMatches = !requestedRef || !row || requestedRef === row.ref || requestedRef === row.head_sha;
  if (row && refMatches && row.cached && row.is_binary !== 1) {
    const object = await env.REPO_BLOBS.get(r2Key(row.blob_sha));
    if (object) {
      return {
        path,
        sha: row.blob_sha,
        size: row.size,
        content: await object.text(),
        source: "mirror",
      };
    }
  }

  const ref = requestedRef || (row && row.ref !== "@default" ? row.ref : undefined) || "main";
  const params = new URLSearchParams({ ref });
  const file = await github(env, `/repos/${repo}/contents/${encodeRepoPath(path)}?${params}`);
  if (Array.isArray(file) || file.type !== "file") throw new HttpError(400, `path is not a regular file: ${path}`);
  return {
    path: file.path,
    sha: file.sha,
    size: file.size,
    content: file.encoding === "base64" ? decodeBase64Utf8(file.content) : String(file.content || ""),
    source: "github-fallback",
  };
}

export async function readMirrorFiles(env, input) {
  requireMirrorBindings(env);
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const paths = validateReadPaths(input.paths);
  const requestedRef = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
  const files = await Promise.all(paths.map((path) => readOneMirrorFile(env, repo, path, requestedRef)));
  return {
    repo,
    ref: requestedRef || null,
    files,
    mirror_hits: files.filter((file) => file.source === "mirror").length,
    github_fallbacks: files.filter((file) => file.source !== "mirror").length,
  };
}

function ftsQuery(input) {
  const tokens = String(input || "")
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_.$/-]{2,}/gu) || [];
  return [...new Set(tokens)].slice(0, 10).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export async function searchMirror(env, input) {
  requireMirrorBindings(env);
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  if (typeof input.query !== "string" || !input.query.trim()) throw new HttpError(400, "query is required");
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : 20;
  const query = ftsQuery(input.query);
  if (!query) throw new HttpError(400, "query contains no searchable terms");

  const row = await getRepositoryRow(env, repo);
  if (!row || row.status === "missing") throw new HttpError(409, "repository mirror is missing; call syncRepository first");

  const result = await env.REPO_DB.prepare(
    `SELECT path,
            snippet(repo_fts, 2, '', '', ' … ', 24) AS snippet,
            bm25(repo_fts) AS rank
       FROM repo_fts
      WHERE repo = ? AND repo_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  ).bind(repo, query, limit).all();

  return {
    repo,
    query: input.query.trim(),
    mirror_status: row.status,
    head_sha: row.head_sha,
    items: result.results || [],
  };
}

export async function readMirrorPage(env, input) {
  requireMirrorBindings(env);
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const row = await getRepositoryRow(env, repo);
  if (!row) throw new HttpError(409, "repository mirror is missing; call syncRepository first");

  const cursor = typeof input.cursor === "string" ? input.cursor : "";
  const maxChars = Number.isInteger(input.max_chars) ? Math.min(Math.max(input.max_chars, 10_000), 250_000) : 120_000;
  const maxFiles = Number.isInteger(input.max_files) ? Math.min(Math.max(input.max_files, 1), 100) : 40;
  const result = await env.REPO_DB.prepare(
    `SELECT path, blob_sha, size
       FROM mirror_files
      WHERE repo = ? AND cached = 1 AND COALESCE(is_binary, 0) = 0 AND path > ?
      ORDER BY path
      LIMIT ?`,
  ).bind(repo, cursor, maxFiles + 1).all();
  const rows = result.results || [];
  const files = [];
  let chars = 0;
  let lastScanned = cursor;
  let stoppedByBudget = false;

  for (const file of rows.slice(0, maxFiles)) {
    const object = await env.REPO_BLOBS.get(r2Key(file.blob_sha));
    lastScanned = file.path;
    if (!object) continue;
    const content = await object.text();
    if (files.length > 0 && chars + content.length > maxChars) {
      stoppedByBudget = true;
      break;
    }
    files.push({ path: file.path, sha: file.blob_sha, size: file.size, content });
    chars += content.length;
    if (chars >= maxChars) {
      stoppedByBudget = true;
      break;
    }
  }

  const hasMore = stoppedByBudget || rows.length > maxFiles;
  return {
    repo,
    ref: row.ref === "@default" ? null : row.ref,
    head_sha: row.head_sha,
    mirror_status: row.status,
    files,
    returned_chars: chars,
    next_cursor: hasMore && lastScanned ? lastScanned : null,
  };
}

async function githubGraphqlBlobs(env, repo, headSha, files) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  const [owner, name] = repo.split("/");
  const definitions = files.map((_, index) => `$e${index}: String!`).join(", ");
  const fields = files.map((_, index) =>
    `f${index}: object(expression: $e${index}) { ... on Blob { oid byteSize isBinary isTruncated text } }`,
  ).join("\n");
  const query = `query($owner: String!, $name: String!, ${definitions}) {
    repository(owner: $owner, name: $name) { ${fields} }
  }`;
  const variables = { owner, name };
  files.forEach((file, index) => { variables[`e${index}`] = `${headSha}:${file.path}`; });
  const transport = env.__graphqlFetch || fetch;
  const response = await transport("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok) throw new HttpError(response.status, payload?.message || "GitHub GraphQL request failed");
  if (!payload?.data?.repository) throw new HttpError(502, payload?.errors?.[0]?.message || "GitHub GraphQL returned no repository data");
  return files.map((file, index) => ({ file, blob: payload.data.repository[`f${index}`] || null }));
}

async function fallbackBlobText(env, repo, file) {
  const blob = await github(env, `/repos/${repo}/git/blobs/${file.blob_sha}`);
  if (blob.encoding !== "base64") return null;
  return decodeBase64Utf8(blob.content);
}

async function indexBlobBatch(env, message) {
  const prior = await env.REPO_DB.prepare(
    `SELECT status FROM sync_batches WHERE sync_id = ? AND batch_id = ?`,
  ).bind(message.sync_id, message.batch_id).first();
  if (prior?.status === "done") return;

  const fetched = await githubGraphqlBlobs(env, message.repo, message.head_sha, message.files);
  const statements = [];
  let mirroredCount = 0;

  for (const { file, blob } of fetched) {
    let isBinary = blob?.isBinary === true;
    let isTruncated = blob?.isTruncated === true;
    let text = typeof blob?.text === "string" ? blob.text : null;

    if (!isBinary && (text === null || isTruncated)) {
      try {
        text = await fallbackBlobText(env, message.repo, file);
        isTruncated = false;
      } catch {
        text = null;
      }
    }

    if (isBinary || text === null) {
      statements.push(
        env.REPO_DB.prepare(
          `INSERT INTO mirror_blobs(blob_sha, size, is_binary, is_truncated, r2_key, cached_at)
           VALUES (?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(blob_sha) DO UPDATE SET is_binary = 1, is_truncated = excluded.is_truncated`,
        ).bind(file.blob_sha, file.size || 0, isTruncated ? 1 : 0),
        env.REPO_DB.prepare(
          `UPDATE mirror_files SET cached = 0, is_binary = 1, is_indexed = 0, updated_at = CURRENT_TIMESTAMP
            WHERE repo = ? AND path = ? AND blob_sha = ? AND sync_id = ?`,
        ).bind(message.repo, file.path, file.blob_sha, message.sync_id),
        env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(message.repo, file.path),
      );
      continue;
    }

    const key = r2Key(file.blob_sha);
    await env.REPO_BLOBS.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { sha: file.blob_sha },
    });
    mirroredCount += 1;
    const indexed = text.slice(0, maxIndexChars(env));
    statements.push(
      env.REPO_DB.prepare(
        `INSERT INTO mirror_blobs(blob_sha, size, is_binary, is_truncated, r2_key, cached_at)
         VALUES (?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(blob_sha) DO UPDATE SET
           size = excluded.size, is_binary = 0, is_truncated = excluded.is_truncated,
           r2_key = excluded.r2_key, cached_at = CURRENT_TIMESTAMP`,
      ).bind(file.blob_sha, file.size || text.length, isTruncated ? 1 : 0, key),
      env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(message.repo, file.path),
      env.REPO_DB.prepare(`INSERT INTO repo_fts(repo, path, content) VALUES (?, ?, ?)`).bind(message.repo, file.path, indexed),
      env.REPO_DB.prepare(
        `UPDATE mirror_files SET cached = 1, is_binary = 0, is_indexed = 1, updated_at = CURRENT_TIMESTAMP
          WHERE repo = ? AND path = ? AND blob_sha = ? AND sync_id = ?`,
      ).bind(message.repo, file.path, file.blob_sha, message.sync_id),
    );
  }

  for (const group of chunks(statements, SQL_BATCH_SIZE)) await env.REPO_DB.batch(group);

  await env.REPO_DB.batch([
    env.REPO_DB.prepare(
      `UPDATE repositories
          SET pending_batches = CASE WHEN pending_batches > 0 THEN pending_batches - 1 ELSE 0 END,
              mirrored_file_count = mirrored_file_count + ?
        WHERE repo = ? AND sync_id = ?
          AND EXISTS (
            SELECT 1 FROM sync_batches
             WHERE sync_id = ? AND batch_id = ? AND status <> 'done'
          )`,
    ).bind(mirroredCount, message.repo, message.sync_id, message.sync_id, message.batch_id),
    env.REPO_DB.prepare(
      `UPDATE sync_batches SET status = 'done', completed_at = CURRENT_TIMESTAMP
        WHERE sync_id = ? AND batch_id = ?`,
    ).bind(message.sync_id, message.batch_id),
  ]);

  const repoRow = await getRepositoryRow(env, message.repo);
  if (repoRow?.sync_id === message.sync_id && repoRow.pending_batches === 0) {
    await finalizeSync(env, message.repo, message.sync_id);
  }
}

async function finalizeSync(env, repo, syncId) {
  await env.REPO_DB.batch([
    env.REPO_DB.prepare(
      `DELETE FROM repo_fts
        WHERE repo = ? AND path IN (
          SELECT path FROM mirror_files WHERE repo = ? AND sync_id <> ?
        )`,
    ).bind(repo, repo, syncId),
    env.REPO_DB.prepare(`DELETE FROM mirror_files WHERE repo = ? AND sync_id <> ?`).bind(repo, syncId),
    env.REPO_DB.prepare(
      `UPDATE repositories
          SET status = 'ready', pending_batches = 0, synced_at = ?, last_error = NULL
        WHERE repo = ? AND sync_id = ?`,
    ).bind(nowIso(), repo, syncId),
  ]);
}

async function processManifest(env, message) {
  const manifestState = await env.REPO_DB.prepare(
    `SELECT status FROM sync_batches WHERE sync_id = ? AND batch_id = '__manifest__'`,
  ).bind(message.sync_id).first();
  if (manifestState?.status === "done") return;

  const meta = await github(env, `/repos/${message.repo}`);
  const ref = message.ref || meta.default_branch || "main";
  const commit = await github(env, `/repos/${message.repo}/commits/${encodeURIComponent(ref)}`);
  const headSha = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!treeSha) throw new HttpError(502, "GitHub commit response did not contain tree SHA");
  const tree = await github(env, `/repos/${message.repo}/git/trees/${treeSha}?recursive=1`);
  const files = (tree.tree || []).filter((entry) => entry.type === "blob").map((entry) => ({
    path: entry.path,
    blob_sha: entry.sha,
    size: entry.size || 0,
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const existingResult = await env.REPO_DB.prepare(
    `SELECT path, blob_sha, cached, is_binary, is_indexed FROM mirror_files WHERE repo = ?`,
  ).bind(message.repo).all();
  const existing = new Map((existingResult.results || []).map((row) => [row.path, row]));
  const mirrorLimit = maxMirrorBytes(env);
  const candidates = [];
  const upserts = [];

  for (const file of files) {
    const old = existing.get(file.path);
    const unchanged = old?.blob_sha === file.blob_sha;
    const eligible = file.size <= mirrorLimit;
    if (eligible && !(unchanged && old.cached)) candidates.push(file);
    upserts.push(env.REPO_DB.prepare(
      `INSERT INTO mirror_files(repo, path, blob_sha, size, cached, is_binary, is_indexed, sync_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(repo, path) DO UPDATE SET
         blob_sha = excluded.blob_sha,
         size = excluded.size,
         cached = excluded.cached,
         is_binary = excluded.is_binary,
         is_indexed = excluded.is_indexed,
         sync_id = excluded.sync_id,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(
      message.repo,
      file.path,
      file.blob_sha,
      file.size,
      unchanged ? Number(old.cached || 0) : 0,
      unchanged ? old.is_binary : null,
      unchanged ? Number(old.is_indexed || 0) : 0,
      message.sync_id,
    ));
  }

  for (const group of chunks(upserts, SQL_BATCH_SIZE)) await env.REPO_DB.batch(group);
  const fileBatches = chunks(candidates, BLOB_BATCH_SIZE);
  const batchRows = fileBatches.map((_, index) => env.REPO_DB.prepare(
    `INSERT OR IGNORE INTO sync_batches(sync_id, batch_id, status) VALUES (?, ?, 'pending')`,
  ).bind(message.sync_id, `blob-${index}`));
  for (const group of chunks(batchRows, SQL_BATCH_SIZE)) await env.REPO_DB.batch(group);

  await env.REPO_DB.prepare(
    `UPDATE repositories
        SET ref = ?, head_sha = ?, default_branch = ?, status = ?, pending_batches = ?,
            file_count = ?, mirrored_file_count = 0, total_bytes = ?, last_error = ?
      WHERE repo = ? AND sync_id = ?`,
  ).bind(
    ref,
    headSha,
    meta.default_branch || "main",
    fileBatches.length ? "syncing" : "ready",
    fileBatches.length,
    files.length,
    totalBytes,
    tree.truncated ? "GitHub recursive tree was truncated" : null,
    message.repo,
    message.sync_id,
  ).run();

  const queueMessages = fileBatches.map((batchFiles, index) => ({
    body: {
      type: "blob-batch",
      repo: message.repo,
      ref,
      head_sha: headSha,
      sync_id: message.sync_id,
      batch_id: `blob-${index}`,
      files: batchFiles,
    },
  }));
  for (const group of chunks(queueMessages, QUEUE_SEND_BATCH_SIZE)) {
    if (group.length) await env.REPO_SYNC_QUEUE.sendBatch(group);
  }

  await env.REPO_DB.prepare(
    `UPDATE sync_batches SET status = 'done', completed_at = CURRENT_TIMESTAMP
      WHERE sync_id = ? AND batch_id = '__manifest__'`,
  ).bind(message.sync_id).run();

  if (fileBatches.length === 0) await finalizeSync(env, message.repo, message.sync_id);
}

export async function handleMirrorQueue(batch, env) {
  requireMirrorBindings(env, { queue: true });
  for (const message of batch.messages) {
    try {
      const body = message.body || {};
      if (body.type === "manifest") await processManifest(env, body);
      else if (body.type === "blob-batch") await indexBlobBatch(env, body);
      else throw new HttpError(400, `unknown mirror queue message: ${body.type}`);
      message.ack();
    } catch (error) {
      const body = message.body || {};
      if (body.repo && body.sync_id) {
        await env.REPO_DB.prepare(
          `UPDATE repositories SET last_error = ? WHERE repo = ? AND sync_id = ?`,
        ).bind(error instanceof Error ? error.message : "mirror queue error", body.repo, body.sync_id).run().catch(() => {});
      }
      message.retry();
    }
  }
}
