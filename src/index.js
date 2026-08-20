const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_CHANGES = 50;
const MAX_FILE_CHARS = 750_000;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization",
  };
}

function normalizeRepo(repo) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new HttpError(400, "repo must be owner/name");
  }
  return repo;
}

function parseAllowlist(value = "") {
  return value.split(",").map((x) => x.trim()).filter(Boolean);
}

function matchesRepoPattern(repo, pattern) {
  if (pattern.endsWith("/*")) return repo.startsWith(pattern.slice(0, -1));
  return repo === pattern;
}

function assertRepoAllowed(env, repo) {
  const patterns = parseAllowlist(env.ALLOWED_REPOS || "");
  if (patterns.length === 0 || !patterns.some((p) => matchesRepoPattern(repo, p))) {
    throw new HttpError(403, `repository is not allowed: ${repo}`);
  }
}

function assertWriteBranch(env, branch) {
  if (typeof branch !== "string" || !branch) throw new HttpError(400, "branch is required");
  const protectedBranches = new Set(["main", "master"]);
  if (protectedBranches.has(branch)) throw new HttpError(403, `direct writes to ${branch} are blocked`);
  const prefix = env.WRITE_BRANCH_PREFIX || "mygpt/";
  if (!branch.startsWith(prefix)) {
    throw new HttpError(403, `write branch must start with ${prefix}`);
  }
}

function readApiKey(request) {
  const direct = request.headers.get("x-api-key");
  if (direct) return direct;
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function assertAuthorized(request, env) {
  if (!env.GPT_API_KEY) throw new HttpError(500, "GPT_API_KEY secret is not configured");
  if (readApiKey(request) !== env.GPT_API_KEY) throw new HttpError(401, "unauthorized");
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function decodeBase64Utf8(input) {
  const clean = String(input || "").replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function github(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  const transport = env.__fetch || fetch;
  const res = await transport(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": GITHUB_API_VERSION,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!res.ok) {
    throw new HttpError(res.status, payload?.message || `GitHub API request failed (${res.status})`, payload);
  }
  return payload;
}

async function health() {
  return json({ ok: true, service: "cloudflare-mygpt-github", version: "0.1.0" });
}

async function listTree(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const ref = input.ref || "main";
  const recursive = input.recursive === false ? "" : "?recursive=1";
  const tree = await github(env, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}${recursive}`);
  const prefix = typeof input.path === "string" && input.path ? input.path.replace(/^\/+|\/+$/g, "") + "/" : "";
  const items = (tree.tree || [])
    .filter((entry) => !prefix || entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix))
    .map(({ path, mode, type, sha, size }) => ({ path, mode, type, sha, size }));
  return { repo, ref, truncated: Boolean(tree.truncated), items };
}

async function readFile(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  if (typeof input.path !== "string" || !input.path) throw new HttpError(400, "path is required");
  const ref = input.ref || "main";
  const qs = new URLSearchParams({ ref });
  const file = await github(env, `/repos/${repo}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}?${qs}`);
  if (Array.isArray(file)) throw new HttpError(400, "path points to a directory, not a file");
  return {
    repo,
    ref,
    path: file.path,
    sha: file.sha,
    size: file.size,
    encoding: "utf-8",
    content: file.encoding === "base64" ? decodeBase64Utf8(file.content) : file.content,
  };
}

async function createBranch(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const branch = input.branch;
  assertWriteBranch(env, branch);
  const from = input.from || "main";
  const source = await github(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
  const created = await github(env, `/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha }),
  });
  return { repo, branch, from, sha: created.object.sha };
}

function assertPathSafe(path) {
  const lower = path.toLowerCase();
  const blockedExact = new Set([".env", "credentials", "credentials.json"]);
  if (blockedExact.has(lower) || lower.startsWith(".env.") || lower.startsWith(".github/workflows/") || lower.endsWith(".pem") || lower.endsWith(".key")) {
    throw new HttpError(403, `sensitive path is blocked: ${path}`);
  }
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new HttpError(400, "changes must be a non-empty array");
  if (changes.length > MAX_CHANGES) throw new HttpError(400, `at most ${MAX_CHANGES} changes are allowed per commit`);
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change.path !== "string" || !change.path || change.path.startsWith("/")) {
      throw new HttpError(400, "each change requires a relative path");
    }
    if (change.path.includes("..")) throw new HttpError(400, `unsafe path: ${change.path}`);
    assertPathSafe(change.path);
    if (seen.has(change.path)) throw new HttpError(400, `duplicate path: ${change.path}`);
    seen.add(change.path);
    const isDelete = change.delete === true;
    if (!isDelete && typeof change.content !== "string") throw new HttpError(400, `content is required for ${change.path}`);
    if (!isDelete && change.content.length > MAX_FILE_CHARS) throw new HttpError(400, `file too large: ${change.path}`);
  }
}

async function commitChanges(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const branch = input.branch;
  assertWriteBranch(env, branch);
  if (typeof input.message !== "string" || !input.message.trim()) throw new HttpError(400, "message is required");
  validateChanges(input.changes);

  const ref = await github(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;
  if (input.expected_head_sha && input.expected_head_sha !== headSha) {
    throw new HttpError(409, "branch head changed", { expected: input.expected_head_sha, actual: headSha });
  }

  const baseCommit = await github(env, `/repos/${repo}/git/commits/${headSha}`);
  const treeEntries = [];
  for (const change of input.changes) {
    if (change.delete === true) {
      treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await github(env, `/repos/${repo}/git/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: change.content, encoding: "utf-8" }),
    });
    treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await github(env, `/repos/${repo}/git/trees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }),
  });
  const commit = await github(env, `/repos/${repo}/git/commits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: input.message.trim(), tree: tree.sha, parents: [headSha] }),
  });
  await github(env, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return {
    repo,
    branch,
    previous_head_sha: headSha,
    commit_sha: commit.sha,
    changed_paths: input.changes.map((c) => c.path),
  };
}

async function createPullRequest(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  assertWriteBranch(env, input.head);
  const base = input.base || "main";
  if (typeof input.title !== "string" || !input.title.trim()) throw new HttpError(400, "title is required");
  const pr = await github(env, `/repos/${repo}/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title.trim(),
      body: input.body || "",
      head: input.head,
      base,
      draft: input.draft !== false,
    }),
  });
  return { repo, number: pr.number, url: pr.html_url, state: pr.state, draft: pr.draft, head: input.head, base };
}

function openApi(origin) {
  const requestSchema = (props, required = []) => ({ type: "object", additionalProperties: false, properties: props, required });
  const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });
  const ok = { "200": { description: "Success" }, "400": { description: "Bad request" }, "401": { description: "Unauthorized" }, "403": { description: "Forbidden" } };
  return {
    openapi: "3.1.0",
    info: { title: "MyGPT GitHub Gateway", version: "0.1.0", description: "Safe GitHub read/write tools for a Custom GPT." },
    servers: [{ url: origin }],
    components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } } },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/health": { get: { operationId: "health", security: [], summary: "Check gateway health", responses: { "200": { description: "Healthy" } } } },
      "/v1/tree": { post: { operationId: "listRepositoryTree", summary: "List repository files", requestBody: jsonBody(requestSchema({ repo: { type: "string" }, ref: { type: "string" }, path: { type: "string" }, recursive: { type: "boolean" } }, ["repo"])), responses: ok } },
      "/v1/files/read": { post: { operationId: "readGitHubFile", summary: "Read a UTF-8 repository file", requestBody: jsonBody(requestSchema({ repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, ["repo", "path"])), responses: ok } },
      "/v1/branches": { post: { operationId: "createGitHubBranch", summary: "Create a protected-prefix working branch", requestBody: jsonBody(requestSchema({ repo: { type: "string" }, branch: { type: "string" }, from: { type: "string" } }, ["repo", "branch"])), responses: ok } },
      "/v1/commit": { post: { operationId: "commitGitHubChanges", summary: "Atomically commit multiple file changes to a working branch", requestBody: jsonBody(requestSchema({ repo: { type: "string" }, branch: { type: "string" }, message: { type: "string" }, expected_head_sha: { type: "string" }, changes: { type: "array", minItems: 1, maxItems: MAX_CHANGES, items: requestSchema({ path: { type: "string" }, content: { type: "string" }, delete: { type: "boolean" } }, ["path"]) } }, ["repo", "branch", "message", "changes"])), responses: { ...ok, "409": { description: "Branch head changed" } } } },
      "/v1/pulls": { post: { operationId: "createGitHubPullRequest", summary: "Create a pull request from a working branch", requestBody: jsonBody(requestSchema({ repo: { type: "string" }, head: { type: "string" }, base: { type: "string" }, title: { type: "string" }, body: { type: "string" }, draft: { type: "boolean" } }, ["repo", "head", "title"])), responses: ok } },
    },
  };
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET" && url.pathname === "/health") return health();
  if (request.method === "GET" && url.pathname === "/openapi.json") return json(openApi(url.origin));

  assertAuthorized(request, env);
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const input = await bodyJson(request);

  if (url.pathname === "/v1/tree") return json(await listTree(env, input));
  if (url.pathname === "/v1/files/read") return json(await readFile(env, input));
  if (url.pathname === "/v1/branches") return json(await createBranch(env, input), 201);
  if (url.pathname === "/v1/commit") return json(await commitChanges(env, input), 201);
  if (url.pathname === "/v1/pulls") return json(await createPullRequest(env, input), 201);
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env) {
    try {
      const res = await route(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const payload = { error: err instanceof Error ? err.message : "internal error" };
      if (err instanceof HttpError && err.details !== undefined) payload.details = err.details;
      return json(payload, status, corsHeaders());
    }
  },
};

export { openApi, matchesRepoPattern };
