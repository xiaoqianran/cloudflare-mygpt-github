import { HttpError } from "./errors.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization",
  };
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export async function bodyJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}

function readApiKey(request) {
  const direct = request.headers.get("x-api-key");
  if (direct) return direct;
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function assertAuthorized(request, env) {
  if (!env.GPT_API_KEY) throw new HttpError(500, "GPT_API_KEY secret is not configured");
  if (readApiKey(request) !== env.GPT_API_KEY) throw new HttpError(401, "unauthorized");
}
