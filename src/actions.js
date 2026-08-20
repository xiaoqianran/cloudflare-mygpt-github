import { HttpError } from "./errors.js";
import { github, githubOrNull, encodeRepoPath, decodeBase64Utf8 } from "./github.js";
import {
  normalizeRepo,
  assertRepoAllowed,
  assertWriteBranch,
  validateReadPaths,
  validateChanges,
} from "./policy.js";

async function repoContext(env, repo) {
  const meta = await github(env, `/repos/${repo}`);
  return {
    default_branch: meta.default_branch || "main",
    private: Boolean(meta.private),
    description: meta.description || "",
    html_url: meta.html_url,
  };
}

export async function inspectRepository(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const context = await repoContext(env, repo);
  const ref = input.ref || context.default_branch;
  const recursive = input.recursive === false ? "" : "?recursive=1";
  const tree = await github(env, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}${recursive}`);
  const prefix = typeof input.path === "string" && input.path
    ? input.path.replace(/^\/+|\/+$/g, "") + "/"
    : "";
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 1000) : 500;
  const items = (tree.tree || [])
    .filter((entry) => !prefix || entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix))
    .slice(0, limit)
    .map(({ path, mode, type, sha, size }) => ({ path, mode, type, sha, size }));
  return { repo, ref, ...context, truncated: Boolean(tree.truncated) || items.length >= limit, items };
}

export async function readFiles(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const paths = validateReadPaths(input.paths);
  const context = input.ref ? null : await repoContext(env, repo);
  const ref = input.ref || context.default_branch;

  const files = await Promise.all(paths.map(async (path) => {
    const qs = new URLSearchParams({ ref });
    const file = await github(env, `/repos/${repo}/contents/${encodeRepoPath(path)}?${qs}`);
    if (Array.isArray(file)) throw new HttpError(400, `path points to a directory: ${path}`);
    if (file.type !== "file") throw new HttpError(400, `path is not a regular file: ${path}`);
    return {
      path: file.path,
      sha: file.sha,
      size: file.size,
      content: file.encoding === "base64" ? decodeBase64Utf8(file.content) : String(file.content || ""),
    };
  }));

  return { repo, ref, files };
}

export async function searchCode(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  if (typeof input.query !== "string" || !input.query.trim()) throw new HttpError(400, "query is required");
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : 20;
  const q = `${input.query.trim()} repo:${repo}`;
  const params = new URLSearchParams({ q, per_page: String(limit) });
  const result = await github(env, `/search/code?${params}`, {
    headers: { accept: "application/vnd.github.text-match+json" },
  });
  return {
    repo,
    query: input.query.trim(),
    total_count: result.total_count || 0,
    items: (result.items || []).map((item) => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      html_url: item.html_url,
      text_matches: item.text_matches || [],
    })),
  };
}

async function ensureBranch(env, repo, branch, base) {
  const existing = await githubOrNull(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (existing) return { created: false, sha: existing.object.sha };
  const source = await github(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const created = await github(env, `/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha }),
  });
  return { created: true, sha: created.object.sha };
}

async function createAtomicCommit(env, repo, branch, headSha, message, changes) {
  const baseCommit = await github(env, `/repos/${repo}/git/commits/${headSha}`);
  const treeEntries = [];
  for (const change of changes) {
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
    body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
  });
  await github(env, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit.sha;
}

async function ensurePullRequest(env, repo, branch, base, shouldCreate, pullRequest, message) {
  if (shouldCreate === false) return null;
  const owner = repo.split("/")[0];
  const params = new URLSearchParams({ state: "open", head: `${owner}:${branch}`, base });
  const existing = await github(env, `/repos/${repo}/pulls?${params}`);
  if (Array.isArray(existing) && existing.length > 0) {
    const pr = existing[0];
    return { number: pr.number, url: pr.html_url, state: pr.state, draft: pr.draft, existing: true };
  }
  const config = pullRequest && typeof pullRequest === "object" ? pullRequest : {};
  const pr = await github(env, `/repos/${repo}/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: typeof config.title === "string" && config.title.trim() ? config.title.trim() : message,
      body: typeof config.body === "string" ? config.body : "",
      head: branch,
      base,
      draft: config.draft !== false,
    }),
  });
  return { number: pr.number, url: pr.html_url, state: pr.state, draft: pr.draft, existing: false };
}

export async function applyChanges(env, input) {
  const repo = normalizeRepo(input.repo);
  assertRepoAllowed(env, repo);
  const branch = assertWriteBranch(env, input.branch);
  if (typeof input.message !== "string" || !input.message.trim()) throw new HttpError(400, "message is required");
  const message = input.message.trim();
  const changes = validateChanges(input.changes);
  const context = input.base ? null : await repoContext(env, repo);
  const base = input.base || context.default_branch;

  const branchState = await ensureBranch(env, repo, branch, base);
  const headRef = await github(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = headRef.object.sha;
  if (input.expected_head_sha && input.expected_head_sha !== headSha) {
    throw new HttpError(409, "branch head changed", { expected: input.expected_head_sha, actual: headSha });
  }

  const commitSha = await createAtomicCommit(env, repo, branch, headSha, message, changes);
  const pullRequest = await ensurePullRequest(env, repo, branch, base, input.create_pull_request, input.pull_request, message);

  return {
    repo,
    base,
    branch,
    branch_created: branchState.created,
    previous_head_sha: headSha,
    commit_sha: commitSha,
    changed_paths: changes.map((change) => change.path),
    ...(pullRequest ? { pull_request: pullRequest } : {}),
  };
}
