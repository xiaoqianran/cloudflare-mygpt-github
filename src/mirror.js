import { HttpError } from "./errors.js";
import { github, githubApiHeaders, encodeRepoPath, decodeBase64Utf8 } from "./github.js";
import { normalizeRepo, assertRepoAllowed, validateReadPaths } from "./policy.js";

const DEFAULT_MAX_MIRROR_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_INDEX_CHARS = 120_000;
const MANIFEST_CHUNK_SIZE = 8;
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

function encodeCursor(path, offset = 0) {
  const bytes = new TextEncoder().encode(JSON.stringify({ path, offset }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor(cursor) {
  if (!cursor) return { path: "", offset: 0 };
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed.path !== "string" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "invalid repository page cursor");
  }
}

async function getRepositoryRow(env, repo) {
  return env.REPO_DB.prepare(
    `SELECT repo, ref, head_sha, default_branch, status, sync_id, pending_batches,
            file_count, mirrored_file_count, total_bytes, tree_truncated,
            sync_started_at, synced_at, last_error
       FROM repositories WHERE repo = ?`,
  ).bind(repo).first();
}

export async function startMirrorSync(env, input) {
  requireMirrorBindings(env, { queue: true });
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const current = await getRepositoryRow(env, repo);
  if (current && (current.status === "queued" || current.status === "syncing") && input.force !== true) {
    return {
      repo,
      ref: current.ref === "@default" ? null : current.ref,
      sync_id: current.sync_id,
      status: current.status,
      already_running: true,
      pending_batches: current.pending_batches,
    };
  }

  const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
  const syncId = crypto.randomUUID();
  const startedAt = nowIso();

  await env.REPO_DB.batch([
    env.REPO_DB.prepare(
      `INSERT INTO repositories
         (repo, ref, head_sha, status, sync_id, pending_batches, file_count,
          mirrored_file_count, total_bytes, tree_truncated, sync_started_at, last_error)
       VALUES (?, ?, NULL, 'queued', ?, 0, 0, 0, 0, 0, ?, NULL)
       ON CONFLICT(repo) DO UPDATE SET
         ref = excluded.ref,
         head_sha = NULL,
         status = 'queued',
         sync_id = excluded.sync_id,
         pending_batches = 0,
         file_count = 0,
         mirrored_file_count = 0,
         total_bytes = 0,
         tree_truncated = 0,
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

  return { repo, ref: ref || null, sync_id: syncId, status: "queued", already_running: false };
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
  const query = prefix
    ? `SELECT path, blob_sha AS sha, size, cached, is_binary, is_indexed
         FROM mirror_files
        WHERE repo = ? AND (path = ? OR path LIKE ?)
        ORDER BY path LIMIT ?`
    : `SELECT path, blob_sha AS sha, size, cached, is_binary, is_indexed
         FROM mirror_files
        WHERE repo = ? ORDER BY path LIMIT ?`;
  const stmt = prefix
    ? env.REPO_DB.prepare(query).bind(repo, prefix, `${prefix}/%`, limit)
    : env.REPO_DB.prepare(query).bind(repo, limit);
  const result = await stmt.all();

  return {
    repo,
    ref: row.ref === "@default" ? null : row.ref,
    head_sha: row.head_sha,
    default_branch: row.default_branch,
    status: row.status,
    ready: row.status === "ready" || row.status === "partial",
    sync_id: row.sync_id,
    pending_batches: row.pending_batches,
    file_count: row.file_count,
    mirrored_file_count: row.mirrored_file_count,
    total_bytes: row.total_bytes,
    tree_truncated: Boolean(row.tree_truncated),
    sync_started_at: row.sync_started_at,
    synced_at: row.synced_at,
    last_error: row.last_error,
    items: result.results || [],
    truncated: (result.results || []).length >= limit,
  };
}

async function readOneMirrorFile(env, repo, path, requestedRef, repositoryRow) {
  const row = await env.REPO_DB.prepare(
    `SELECT path, blob_sha, size, cached, is_binary
       FROM mirror_files WHERE repo = ? AND path = ?`,
  ).bind(repo, path).first();

  const mirrorRef = repositoryRow?.ref === "@default" ? repositoryRow?.default_branch : repositoryRow?.ref;
  const refMatches = !requestedRef || requestedRef === mirrorRef || requestedRef === repositoryRow?.head_sha;
  if (row && refMatches && row.cached && row.is_binary !== 1) {
    const object = await env.REPO_BLOBS.get(r2Key(row.blob_sha));
    if (object) {
      return { path, sha: row.blob_sha, size: row.size, content: await object.text(), source: "mirror" };
    }
  }

  const ref = requestedRef || mirrorRef || repositoryRow?.default_branch || "main";
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
  const repositoryRow = await getRepositoryRow(env, repo);
  const files = await Promise.all(paths.map((path) => readOneMirrorFile(env, repo, path, requestedRef, repositoryRow)));
  return {
    repo,
    ref: requestedRef || (repositoryRow?.ref === "@default" ? repositoryRow?.default_branch : repositoryRow?.ref) || null,
    mirror_status: repositoryRow?.status || "missing",
    files,
    mirror_hits: files.filter((file) => file.source === "mirror").length,
    github_fallbacks: files.filter((file) => file.source !== "mirror").length,
  };
}

export function buildFtsQuery(input) {
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
  const query = buildFtsQuery(input.query);
  if (!query) throw new HttpError(400, "query contains no searchable terms");

  const row = await getRepositoryRow(env, repo);
  if (!row) throw new HttpError(409, "repository mirror is missing; call syncRepository first");

  const result = await env.REPO_DB.prepare(
    `SELECT path,
            snippet(repo_fts, 2, '', '', ' … ', 24) AS snippet,
            bm25(repo_fts) AS rank
       FROM repo_fts
      WHERE repo = ? AND repo_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  ).bind(repo, query, limit).all();

  return { repo, query: input.query.trim(), mirror_status: row.status, head_sha: row.head_sha, items: result.results || [] };
}

export async function readMirrorPage(env, input) {
  requireMirrorBindings(env);
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const row = await getRepositoryRow(env, repo);
  if (!row) throw new HttpError(409, "repository mirror is missing; call syncRepository first");

  const cursor = decodeCursor(typeof input.cursor === "string" ? input.cursor : "");
  const maxChars = Number.isInteger(input.max_chars) ? Math.min(Math.max(input.max_chars, 10_000), 250_000) : 120_000;
  const maxFiles = Number.isInteger(input.max_files) ? Math.min(Math.max(input.max_files, 1), 100) : 40;
  const query = cursor.offset > 0
    ? `SELECT path, blob_sha, size FROM mirror_files
        WHERE repo = ? AND cached = 1 AND COALESCE(is_binary, 0) = 0 AND path >= ?
        ORDER BY path LIMIT ?`
    : `SELECT path, blob_sha, size FROM mirror_files
        WHERE repo = ? AND cached = 1 AND COALESCE(is_binary, 0) = 0 AND path > ?
        ORDER BY path LIMIT ?`;
  const result = await env.REPO_DB.prepare(query).bind(repo, cursor.path, maxFiles + 1).all();
  const rows = result.results || [];
  const files = [];
  let chars = 0;
  let lastCompletedPath = cursor.offset > 0 ? "" : cursor.path;
  let nextCursor = null;
  let processedRows = 0;

  for (const file of rows.slice(0, maxFiles)) {
    const object = await env.REPO_BLOBS.get(r2Key(file.blob_sha));
    processedRows += 1;
    if (!object) {
      lastCompletedPath = file.path;
      continue;
    }
    const content = await object.text();
    const startOffset = file.path === cursor.path ? cursor.offset : 0;
    const remaining = maxChars - chars;
    const piece = content.slice(startOffset, startOffset + remaining);
    files.push({
      path: file.path,
      sha: file.blob_sha,
      size: file.size,
      offset: startOffset,
      content: piece,
      complete: startOffset + piece.length >= content.length,
    });
    chars += piece.length;

    if (startOffset + piece.length < content.length) {
      nextCursor = encodeCursor(file.path, startOffset + piece.length);
      break;
    }

    lastCompletedPath = file.path;
    if (chars >= maxChars) {
      if (processedRows < rows.length) nextCursor = encodeCursor(file.path, 0);
      break;
    }
  }

  if (!nextCursor && (rows.length > maxFiles || processedRows < rows.length)) {
    nextCursor = encodeCursor(lastCompletedPath, 0);
  }

  return {
    repo,
    ref: row.ref === "@default" ? row.default_branch : row.ref,
    head_sha: row.head_sha,
    mirror_status: row.status,
    files,
    returned_chars: chars,
    next_cursor: nextCursor,
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
    headers: githubApiHeaders(env, { "content-type": "application/json" }),
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

async function maybeFinalizeSync(env, repo, syncId) {
  const row = await getRepositoryRow(env, repo);
  if (!row || row.sync_id !== syncId || row.pending_batches !== 0) return;
  const manifest = await env.REPO_DB.prepare(
    `SELECT status FROM sync_batches WHERE sync_id = ? AND batch_id = '__manifest__'`,
  ).bind(syncId).first();
  if (manifest?.status !== "done") return;

  const truncated = Number(row.tree_truncated || 0) === 1;
  const statements = [];
  if (!truncated) {
    statements.push(
      env.REPO_DB.prepare(
        `DELETE FROM repo_fts
          WHERE repo = ? AND path IN (
            SELECT path FROM mirror_files WHERE repo = ? AND sync_id <> ?
          )`,
      ).bind(repo, repo, syncId),
      env.REPO_DB.prepare(`DELETE FROM mirror_files WHERE repo = ? AND sync_id <> ?`).bind(repo, syncId),
    );
  }
  statements.push(
    env.REPO_DB.prepare(
      `UPDATE repositories
          SET status = ?, pending_batches = 0, synced_at = ?, last_error = ?
        WHERE repo = ? AND sync_id = ? AND pending_batches = 0`,
    ).bind(
      truncated ? "partial" : "ready",
      nowIso(),
      truncated ? "GitHub recursive tree was truncated" : null,
      repo,
      syncId,
    ),
  );
  await env.REPO_DB.batch(statements);
}

async function processManifest(env, message) {
  const marker = await env.REPO_DB.prepare(
    `SELECT status FROM sync_batches WHERE sync_id = ? AND batch_id = '__manifest__'`,
  ).bind(message.sync_id).first();
  if (marker?.status === "done") {
    await maybeFinalizeSync(env, message.repo, message.sync_id);
    return;
  }

  let current = await getRepositoryRow(env, message.repo);
  if (!current || current.sync_id !== message.sync_id) return;

  let meta;
  let ref;
  let headSha;
  let commit;

  if (current.head_sha) {
    ref = current.ref === "@default" ? (current.default_branch || "main") : current.ref;
    headSha = current.head_sha;
    commit = await github(env, `/repos/${message.repo}/commits/${headSha}`);
    meta = { default_branch: current.default_branch || "main" };
  } else {
    meta = await github(env, `/repos/${message.repo}`);
    ref = message.ref || meta.default_branch || "main";
    commit = await github(env, `/repos/${message.repo}/commits/${encodeURIComponent(ref)}`);
    headSha = commit.sha;
  }

  const treeSha = commit.commit?.tree?.sha;
  if (!treeSha) throw new HttpError(502, "GitHub commit response did not contain tree SHA");
  const tree = await github(env, `/repos/${message.repo}/git/trees/${treeSha}?recursive=1`);
  const files = (tree.tree || [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({ path: entry.path, blob_sha: entry.sha, size: entry.size || 0 }));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const fileChunks = chunks(files, MANIFEST_CHUNK_SIZE);

  // Only the first manifest attempt initializes counters. Retries use the stored
  // head SHA and do not reset progress already made by chunk consumers.
  await env.REPO_DB.prepare(
    `UPDATE repositories
        SET ref = ?, head_sha = ?, default_branch = ?, status = ?, pending_batches = ?,
            file_count = ?, mirrored_file_count = 0, total_bytes = ?, tree_truncated = ?, last_error = NULL
      WHERE repo = ? AND sync_id = ? AND head_sha IS NULL`,
  ).bind(
    ref,
    headSha,
    meta.default_branch || "main",
    fileChunks.length ? "syncing" : (tree.truncated ? "partial" : "ready"),
    fileChunks.length,
    files.length,
    totalBytes,
    tree.truncated ? 1 : 0,
    message.repo,
    message.sync_id,
  ).run();

  current = await getRepositoryRow(env, message.repo);
  if (!current || current.sync_id !== message.sync_id) return;

  const queueMessages = fileChunks.map((chunkFiles, index) => ({
    body: {
      type: "manifest-chunk",
      repo: message.repo,
      ref,
      head_sha: headSha,
      sync_id: message.sync_id,
      batch_id: `manifest-${index}`,
      files: chunkFiles,
    },
  }));

  // Queue delivery is at-least-once. If one sendBatch call fails, the manifest
  // message retries and resends deterministic chunk IDs; chunk handlers are idempotent.
  for (const group of chunks(queueMessages, QUEUE_SEND_BATCH_SIZE)) {
    if (group.length) await env.REPO_SYNC_QUEUE.sendBatch(group);
  }

  await env.REPO_DB.prepare(
    `UPDATE sync_batches SET status = 'done', completed_at = CURRENT_TIMESTAMP
      WHERE sync_id = ? AND batch_id = '__manifest__'`,
  ).bind(message.sync_id).run();

  await maybeFinalizeSync(env, message.repo, message.sync_id);
}

async function processManifestChunk(env, message) {
  const current = await getRepositoryRow(env, message.repo);
  if (!current || current.sync_id !== message.sync_id) return;

  await env.REPO_DB.prepare(
    `INSERT OR IGNORE INTO sync_batches(sync_id, batch_id, status, completed_at)
     VALUES (?, ?, 'pending', NULL)`,
  ).bind(message.sync_id, message.batch_id).run();
  const prior = await env.REPO_DB.prepare(
    `SELECT status FROM sync_batches WHERE sync_id = ? AND batch_id = ?`,
  ).bind(message.sync_id, message.batch_id).first();
  if (prior?.status === "done") {
    await maybeFinalizeSync(env, message.repo, message.sync_id);
    return;
  }

  const paths = message.files.map((file) => file.path);
  const placeholders = paths.map(() => "?").join(",");
  const existingResult = paths.length
    ? await env.REPO_DB.prepare(
      `SELECT path, blob_sha, cached, is_binary, is_indexed
         FROM mirror_files WHERE repo = ? AND path IN (${placeholders})`,
    ).bind(message.repo, ...paths).all()
    : { results: [] };
  const existing = new Map((existingResult.results || []).map((row) => [row.path, row]));
  const mirrorLimit = maxMirrorBytes(env);
  const candidates = [];
  const upserts = [];
  const staleFtsDeletes = [];
  let mirroredCurrent = 0;

  for (const file of message.files) {
    const old = existing.get(file.path);
    const unchanged = old?.blob_sha === file.blob_sha;
    const oldCached = unchanged ? Number(old.cached || 0) : 0;
    const oldBinary = unchanged ? old.is_binary : null;
    const oldIndexed = unchanged ? Number(old.is_indexed || 0) : 0;
    const eligible = file.size <= mirrorLimit;
    const knownHandled = oldCached === 1 || Number(oldBinary || 0) === 1;

    if (oldCached === 1) mirroredCurrent += 1;
    if (eligible && !knownHandled) candidates.push(file);
    if (!unchanged && !eligible) {
      staleFtsDeletes.push(env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(message.repo, file.path));
    }

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
      oldCached,
      oldBinary,
      oldIndexed,
      message.sync_id,
    ));
  }

  if (upserts.length) await env.REPO_DB.batch(upserts);
  if (staleFtsDeletes.length) await env.REPO_DB.batch(staleFtsDeletes);

  if (candidates.length) {
    const fetched = await githubGraphqlBlobs(env, message.repo, message.head_sha, candidates);
    const indexStatements = [];

    for (const { file, blob } of fetched) {
      const isBinary = blob?.isBinary === true;
      let isTruncated = blob?.isTruncated === true;
      let text = typeof blob?.text === "string" ? blob.text : null;

      if (!isBinary && (text === null || isTruncated)) {
        text = await fallbackBlobText(env, message.repo, file);
        isTruncated = false;
      }

      if (isBinary) {
        indexStatements.push(
          env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(message.repo, file.path),
          env.REPO_DB.prepare(
            `UPDATE mirror_files
                SET cached = 0, is_binary = 1, is_indexed = 0, updated_at = CURRENT_TIMESTAMP
              WHERE repo = ? AND path = ? AND blob_sha = ? AND sync_id = ?`,
          ).bind(message.repo, file.path, file.blob_sha, message.sync_id),
        );
        continue;
      }

      if (text === null) throw new HttpError(502, `unable to read GitHub blob text: ${file.path}`);
      const key = r2Key(file.blob_sha);
      await env.REPO_BLOBS.put(key, text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { sha: file.blob_sha, truncated: isTruncated ? "1" : "0" },
      });
      mirroredCurrent += 1;
      indexStatements.push(
        env.REPO_DB.prepare(`DELETE FROM repo_fts WHERE repo = ? AND path = ?`).bind(message.repo, file.path),
        env.REPO_DB.prepare(`INSERT INTO repo_fts(repo, path, content) VALUES (?, ?, ?)`).bind(
          message.repo,
          file.path,
          text.slice(0, maxIndexChars(env)),
        ),
        env.REPO_DB.prepare(
          `UPDATE mirror_files
              SET cached = 1, is_binary = 0, is_indexed = 1, updated_at = CURRENT_TIMESTAMP
            WHERE repo = ? AND path = ? AND blob_sha = ? AND sync_id = ?`,
        ).bind(message.repo, file.path, file.blob_sha, message.sync_id),
      );
    }

    if (indexStatements.length) await env.REPO_DB.batch(indexStatements);
  }

  // One Queue message contains at most eight files, keeping the number of D1
  // statements bounded even on the Workers/D1 free tier. The conditional update
  // makes an at-least-once delivery unable to double-count completion.
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
    ).bind(mirroredCurrent, message.repo, message.sync_id, message.sync_id, message.batch_id),
    env.REPO_DB.prepare(
      `UPDATE sync_batches SET status = 'done', completed_at = CURRENT_TIMESTAMP
        WHERE sync_id = ? AND batch_id = ?`,
    ).bind(message.sync_id, message.batch_id),
  ]);

  await maybeFinalizeSync(env, message.repo, message.sync_id);
}

export async function handleMirrorQueue(batch, env) {
  requireMirrorBindings(env, { queue: true });
  for (const message of batch.messages) {
    try {
      const body = message.body || {};
      if (body.type === "manifest") await processManifest(env, body);
      else if (body.type === "manifest-chunk") await processManifestChunk(env, body);
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
