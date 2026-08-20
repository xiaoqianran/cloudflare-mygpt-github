import { HttpError } from "./errors.js";
import { normalizeRepo, assertRepoAllowed } from "./policy.js";

const GITHUB_WEB = "https://github.com";
const MAX_COMMAND_SECTION_BYTES = 64 * 1024;
const MAX_INSPECTION_BUFFER_BYTES = 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

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

function pushEnabled(env) {
  return /^(1|true|yes|on)$/i.test(String(env.ENABLE_GIT_PUSH || "false"));
}

function githubGitAuthorization(env) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN secret is not configured");
  // GitHub HTTPS Git accepts a personal access token as the Basic-auth password.
  return `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`;
}

function upstreamHeaders(request, env) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "git-protocol", "user-agent"]) {
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

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function parseCommandPayload(payload, first) {
  let line = new TextDecoder().decode(payload).replace(/\n$/, "");
  if (first) line = line.split("\0", 1)[0];
  const parts = line.split(" ");
  if (parts.length !== 3 || !SHA_RE.test(parts[0]) || !SHA_RE.test(parts[1]) || !parts[2].startsWith("refs/")) {
    throw new HttpError(400, "unsupported git receive-pack command");
  }
  return { oldSha: parts[0], newSha: parts[1], ref: parts[2] };
}

async function inspectReceivePackBody(body) {
  if (!body) throw new HttpError(400, "git-receive-pack request body is required");
  const [inspectionStream, forwardStream] = body.tee();
  const reader = inspectionStream.getReader();
  let buffer = new Uint8Array(0);
  let offset = 0;
  let first = true;
  const commands = [];

  try {
    while (true) {
      while (buffer.length - offset < 4) {
        const { value, done } = await reader.read();
        if (done) throw new HttpError(400, "truncated git receive-pack command section");
        buffer = concatBytes(buffer.slice(offset), value);
        offset = 0;
        if (buffer.length > MAX_INSPECTION_BUFFER_BYTES) {
          throw new HttpError(413, "git receive-pack inspection buffer exceeded");
        }
      }

      const prefix = new TextDecoder().decode(buffer.slice(offset, offset + 4));
      if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new HttpError(400, "invalid git pkt-line length");
      const packetLength = Number.parseInt(prefix, 16);

      if (packetLength === 0) {
        offset += 4;
        if (offset > MAX_COMMAND_SECTION_BYTES) throw new HttpError(413, "git command section is too large");
        break;
      }
      if (packetLength < 4) throw new HttpError(400, "unsupported git pkt-line control packet");
      if (offset + packetLength > MAX_COMMAND_SECTION_BYTES) {
        throw new HttpError(413, "git command section is too large");
      }

      while (buffer.length - offset < packetLength) {
        const { value, done } = await reader.read();
        if (done) throw new HttpError(400, "truncated git pkt-line");
        buffer = concatBytes(buffer.slice(offset), value);
        offset = 0;
        if (buffer.length > MAX_INSPECTION_BUFFER_BYTES) {
          throw new HttpError(413, "git receive-pack inspection buffer exceeded");
        }
      }

      const payload = buffer.slice(offset + 4, offset + packetLength);
      commands.push(parseCommandPayload(payload, first));
      first = false;
      offset += packetLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (commands.length === 0) throw new HttpError(400, "git push contained no ref updates");
  return { commands, forwardStream };
}

function validatePushCommands(commands, env) {
  const branchPrefix = env.WRITE_BRANCH_PREFIX || "mygpt/";
  const allowedRefPrefix = `refs/heads/${branchPrefix}`;
  for (const command of commands) {
    if (!command.ref.startsWith(allowedRefPrefix)) {
      throw new HttpError(403, `git push may only update ${allowedRefPrefix}*`);
    }
    if (/^0+$/.test(command.newSha)) {
      throw new HttpError(403, "git branch deletion through the gateway is blocked");
    }
  }
}

async function fetchGitHubSmart(env, url, init) {
  const transport = env.__gitFetch || fetch;
  const response = await transport(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    // Never expose a GitHub redirect to the local Git client, otherwise the client
    // could bypass this gateway (and its DNS/network isolation) or leak credentials.
    throw new HttpError(502, "GitHub Smart HTTP returned a redirect; use the repository's current canonical name");
  }
  return response;
}

function validateMethodAndService(request, url, endpoint, env) {
  if (endpoint === "info/refs") {
    if (request.method !== "GET") throw new HttpError(405, "info/refs requires GET");
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw new HttpError(400, "unsupported Git Smart HTTP service");
    }
    if (service === "git-receive-pack" && !pushEnabled(env)) {
      throw new HttpError(403, "git push through the gateway is disabled");
    }
    return service;
  }

  if (request.method !== "POST") throw new HttpError(405, `${endpoint} requires POST`);
  if (endpoint === "git-receive-pack" && !pushEnabled(env)) {
    throw new HttpError(403, "git push through the gateway is disabled");
  }
  return endpoint;
}

export async function handleGitBridge(request, env) {
  const url = new URL(request.url);
  const route = parseGitRoute(url.pathname);
  if (!route) throw new HttpError(404, "git bridge route not found");
  if (!env.GIT_GATEWAY_TOKEN) throw new HttpError(503, "GIT_GATEWAY_TOKEN secret is not configured");
  if (!isGitClientAuthorized(request, env)) return gitAuthChallenge();

  const repo = normalizeRepo(route.repo);
  assertRepoAllowed(env, repo);
  validateMethodAndService(request, url, route.endpoint, env);

  let body = request.method === "POST" ? request.body : undefined;
  if (route.endpoint === "git-receive-pack") {
    const encoding = request.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw new HttpError(415, "compressed git-receive-pack requests are not supported because ref updates must be inspected");
    }
    const inspected = await inspectReceivePackBody(request.body);
    validatePushCommands(inspected.commands, env);
    body = inspected.forwardStream;
  }

  const upstreamUrl = `${GITHUB_WEB}/${repo}.git/${route.endpoint}${route.endpoint === "info/refs" ? url.search : ""}`;
  const upstream = await fetchGitHubSmart(env, upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders(request, env),
    ...(body ? { body } : {}),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: downstreamHeaders(upstream),
  });
}

export { inspectReceivePackBody, validatePushCommands };
