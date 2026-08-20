import { HttpError } from "./errors.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export async function github(env, path, init = {}) {
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
  if (!res.ok) throw new HttpError(res.status, payload?.message || `GitHub API request failed (${res.status})`);
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
