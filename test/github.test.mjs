import test from "node:test";
import assert from "node:assert/strict";
import { github, githubApiHeaders, githubUserAgent } from "../src/github.js";

test("GitHub API headers always include a valid User-Agent", () => {
  const env = { GITHUB_TOKEN: "token" };
  const headers = githubApiHeaders(env);
  assert.match(headers["user-agent"], /^cloudflare-mygpt-github\//);
  assert.equal(headers.authorization, "Bearer token");
  assert.equal(headers.accept, "application/vnd.github+json");
});

test("GitHub User-Agent can be overridden without exposing token logic", () => {
  const env = { GITHUB_TOKEN: "token", GITHUB_USER_AGENT: "xiaoqianran-cloudflare-github/1.0" };
  assert.equal(githubUserAgent(env), "xiaoqianran-cloudflare-github/1.0");
  assert.equal(githubApiHeaders(env)["user-agent"], "xiaoqianran-cloudflare-github/1.0");
});

test("REST transport receives the User-Agent header", async () => {
  let seen;
  const env = {
    GITHUB_TOKEN: "token",
    __fetch: async (_url, init) => {
      seen = new Headers(init.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  const result = await github(env, "/zen");
  assert.deepEqual(result, { ok: true });
  assert.match(seen.get("user-agent"), /^cloudflare-mygpt-github\//);
  assert.equal(seen.get("authorization"), "Bearer token");
});
