import { HttpError } from "./errors.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_GITHUB_USER_AGENT = "cloudflare-mygpt-github/0.7.0 (+https://github.com/xiaoqianran/cloudflare-mygpt-github)";

export function githubUserAgent(env = {}) {
  const configured = typeof env.GITHUB_USER_AGENT === "string" ? env.GITHUB_USER_AGENT.trim() : "";
  return configured || DEFAULT_GITHUB_USER_AGENT;
}

export function githubApiHeaders(env, extra = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "user-agent": githubUserAgent(env),
    "x-github-api-version": GITHUB_API_VERSION,
    ...extra,
  };
}

export async function github(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  const transport = env.__fetch || fetch;
  const res = await transport(`${GITHUB_API}${path}`, {
    ...init,
    headers: githubApiHeaders(env, init.headers || {}),
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!res.ok) {
    throw new HttpError(
      res.status,
      payload?.message || `GitHub API request failed (${res.status})`,
      {
        documentation_url: payload?.documentation_url,
        errors: payload?.errors,
        request_id: res.headers.get("x-github-request-id") || undefined,
        rate_limit_remaining: res.headers.get("x-ratelimit-remaining") || undefined,
        rate_limit_reset: res.headers.get("x-ratelimit-reset") || undefined,
      },
    );
  }
  return payload;
}

export async function githubOrNull(env, path, init = {}) {
  try {
    return await github(env, path, init);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export function encodeRepoPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function decodeBase64Utf8(input) {
  const clean = String(input || "").replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
