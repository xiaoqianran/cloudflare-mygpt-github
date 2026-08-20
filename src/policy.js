import { HttpError } from "./errors.js";

const DEFAULT_WRITE_PREFIX = "mygpt/";
const MAX_READ_FILES = 20;
const MAX_CHANGES = 50;
const MAX_FILE_CHARS = 750_000;

export function normalizeRepo(repo) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new HttpError(400, "repo must be owner/name");
  }
  return repo;
}

function parseAllowlist(value = "") {
  return value.split(",").map((x) => x.trim()).filter(Boolean);
}

export function matchesRepoPattern(repo, pattern) {
  if (pattern.endsWith("/*")) return repo.startsWith(pattern.slice(0, -1));
  return repo === pattern;
}

export function assertRepoAllowed(env, repo) {
  const patterns = parseAllowlist(env.ALLOWED_REPOS || "");
  if (patterns.length === 0 || !patterns.some((pattern) => matchesRepoPattern(repo, pattern))) {
    throw new HttpError(403, `repository is not allowed: ${repo}`);
  }
}

function validateRelativePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0")) {
    throw new HttpError(400, "path must be a non-empty relative repository path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new HttpError(400, `unsafe path: ${path}`);
  }
  return path;
}

function isSensitivePath(path) {
  const lower = path.toLowerCase();
  const basename = lower.split("/").at(-1);
  return (
    basename === ".env" ||
    basename?.startsWith(".env.") ||
    basename === "credentials" ||
    basename === "credentials.json" ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx")
  );
}

// Read access intentionally covers every valid repository-relative path. The
// mirror is meant to let Custom GPT understand the whole repository, including
// files that the old safety-focused reader used to hide.
export function assertReadablePath(path) {
  return validateRelativePath(path);
}

export function assertWritablePath(path) {
  validateRelativePath(path);
  const lower = path.toLowerCase();
  if (isSensitivePath(path) || lower.startsWith(".github/workflows/")) {
    throw new HttpError(403, `protected path is blocked: ${path}`);
  }
  return path;
}

export function assertWriteBranch(env, branch) {
  if (typeof branch !== "string" || !branch) throw new HttpError(400, "branch is required");
  if (branch === "main" || branch === "master") throw new HttpError(403, `direct writes to ${branch} are blocked`);
  const prefix = env.WRITE_BRANCH_PREFIX || DEFAULT_WRITE_PREFIX;
  if (!branch.startsWith(prefix)) throw new HttpError(403, `write branch must start with ${prefix}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new HttpError(400, "branch contains unsupported characters");
  }
  return branch;
}

export function validateReadPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new HttpError(400, "paths must be a non-empty array");
  if (paths.length > MAX_READ_FILES) throw new HttpError(400, `at most ${MAX_READ_FILES} files can be read per request`);
  return paths.map(assertReadablePath);
}

export function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new HttpError(400, "changes must be a non-empty array");
  if (changes.length > MAX_CHANGES) throw new HttpError(400, `at most ${MAX_CHANGES} changes are allowed per commit`);
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change !== "object") throw new HttpError(400, "each change must be an object");
    assertWritablePath(change.path);
    if (seen.has(change.path)) throw new HttpError(400, `duplicate path: ${change.path}`);
    seen.add(change.path);
    if (change.delete === true) {
      if (change.content !== undefined) throw new HttpError(400, `delete change must not include content: ${change.path}`);
      continue;
    }
    if (typeof change.content !== "string") throw new HttpError(400, `content is required for ${change.path}`);
    if (change.content.length > MAX_FILE_CHARS) throw new HttpError(400, `file too large: ${change.path}`);
  }
  return changes;
}

export const limits = { MAX_READ_FILES, MAX_CHANGES, MAX_FILE_CHARS };
