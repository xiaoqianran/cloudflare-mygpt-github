import { HttpError } from "./errors.js";
import { normalizeRepo } from "./policy.js";

const GITHUB_WEB = "https://github.com";

function gitAuthChallenge() {
  return new Response("Git gateway authentication required\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="cloudflare-mygpt-github"',
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function decodeBasicAuth(header) {
  const match = String(header || "").match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isGitClientAuthorized(request, env) {
  if (!env.GIT_GATEWAY_TOKEN) return false;
  const credentials = decodeBasicAuth(request.headers.get("authorization"));
  return Boolean(credentials?.username) && credentials.password === env.GIT_GATEWAY_TOKEN;
}

export function parseGitRoute(pathname) {
  const match = String(pathname || "").match(
    /^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/,
  );
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    endpoint: match[3],
  };
}

function githubGitAuthorization(env) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  return `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`;
}

function upstreamHeaders(request, env) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "content-encoding", "git-protocol", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", githubGitAuthorization(env));
  headers.set("cache-control", "no-cache");
  return headers;
}

function downstreamHeaders(upstream) {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "pragma",
    "expires",
    "x-github-request-id",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  return headers;
}

function validateMethodAndService(request, url, endpoint) {
  if (endpoint === "info/refs") {
    if (request.method !== "GET") throw new HttpError(405, "info/refs requires GET");
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw new HttpError(400, "unsupported Git Smart HTTP service");
    }
    return;
  }

  if (request.method !== "POST") throw new HttpError(405, `${endpoint} requires POST`);
}

async function fetchGitHubSmart(env, url, init) {
  const transport = env.__gitFetch || fetch;
  const response = await transport(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(502, "GitHub Smart HTTP returned a redirect; use the repository's current canonical name");
  }
  return response;
}

export async function handleGitBridge(request, env) {
  const url = new URL(request.url);
  const route = parseGitRoute(url.pathname);
  if (!route) throw new HttpError(404, "git bridge route not found");
  if (!env.GIT_GATEWAY_TOKEN) throw new HttpError(503, "GIT_GATEWAY_TOKEN secret is not configured");
  if (!isGitClientAuthorized(request, env)) return gitAuthChallenge();

  const repo = normalizeRepo(route.repo);
  validateMethodAndService(request, url, route.endpoint);

  const upstreamUrl = `${GITHUB_WEB}/${repo}.git/${route.endpoint}${route.endpoint === "info/refs" ? url.search : ""}`;
  const upstream = await fetchGitHubSmart(env, upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders(request, env),
    ...(request.method === "POST" && request.body ? { body: request.body } : {}),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: downstreamHeaders(upstream),
  });
}
