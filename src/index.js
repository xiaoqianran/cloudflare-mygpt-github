import { HttpError } from "./errors.js";
import { json, corsHeaders, bodyJson, assertAuthorized } from "./http.js";
import { applyChanges } from "./actions.js";
import {
  startMirrorSync,
  inspectMirror,
  readMirrorFiles,
  searchMirror,
  readMirrorPage,
  handleMirrorQueue,
} from "./mirror.js";
import { openApi as buildOpenApi } from "./openapi.js";
import { handleGitBridge, parseGitRoute } from "./git-bridge.js";

export function openApi(origin) {
  return buildOpenApi(origin);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "cloudflare-mygpt-github", version: "0.6.1" });
  }
  if (request.method === "GET" && url.pathname === "/openapi.json") {
    return json(openApi(url.origin));
  }

  // Native Git remains a separate transparent Smart HTTP data plane.
  if (parseGitRoute(url.pathname)) return handleGitBridge(request, env);

  assertAuthorized(request, env);
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const input = await bodyJson(request);

  if (url.pathname === "/v1/repository/sync") return json(await startMirrorSync(env, input), 202);
  if (url.pathname === "/v1/repository/inspect") return json(await inspectMirror(env, input));
  if (url.pathname === "/v1/files/read") return json(await readMirrorFiles(env, input));
  if (url.pathname === "/v1/repository/search") return json(await searchMirror(env, input));
  if (url.pathname === "/v1/repository/page") return json(await readMirrorPage(env, input));
  if (url.pathname === "/v1/changes/apply") return json(await applyChanges(env, input));
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const payload = { error: error instanceof Error ? error.message : "internal error" };
      if (error instanceof HttpError && error.details !== undefined) payload.details = error.details;
      return json(payload, status, corsHeaders());
    }
  },

  async queue(batch, env) {
    await handleMirrorQueue(batch, env);
  },
};

export { matchesRepoPattern } from "./policy.js";
export { parseGitRoute } from "./git-bridge.js";
