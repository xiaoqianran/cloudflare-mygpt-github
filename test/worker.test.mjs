import test from "node:test";
import assert from "node:assert/strict";
import worker, { openApi, matchesRepoPattern } from "../src/index.js";

const envBase = {
  GPT_API_KEY: "test-gpt-key",
  GITHUB_TOKEN: "test-github-token",
  ALLOWED_REPOS: "xiaoqianran/*",
  WRITE_BRANCH_PREFIX: "mygpt/",
};

function req(path, body, key = "test-gpt-key") {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
}

function mockFetch(routes) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const key = `${(init.method || "GET").toUpperCase()} ${u.pathname}${u.search}`;
    const result = routes[key];
    if (!result) return new Response(JSON.stringify({ message: `unmocked ${key}` }), { status: 500, headers: { "content-type": "application/json" } });
    const value = typeof result === "function" ? await result(init) : result;
    return new Response(JSON.stringify(value.body ?? value), { status: value.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

test("allowlist wildcard", () => {
  assert.equal(matchesRepoPattern("xiaoqianran/demo", "xiaoqianran/*"), true);
  assert.equal(matchesRepoPattern("other/demo", "xiaoqianran/*"), false);
});

test("OpenAPI is GPT Actions friendly and schemas is an object", () => {
  const spec = openApi("https://gateway.example");
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://gateway.example");
  assert.ok(spec.components && typeof spec.components === "object");
  assert.ok(spec.components.schemas && typeof spec.components.schemas === "object" && !Array.isArray(spec.components.schemas));
  assert.ok(spec.components.responses && typeof spec.components.responses === "object");
  assert.equal(Object.keys(spec.paths).length, 4);
  assert.equal(spec.paths["/v1/changes/apply"].post.operationId, "applyChanges");
});

test("health and OpenAPI are public", async () => {
  const health = await worker.fetch(new Request("https://gateway.example/health"), {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "0.2.0");
  const schema = await worker.fetch(new Request("https://gateway.example/openapi.json"), {});
  assert.equal(schema.status, 200);
  assert.ok((await schema.json()).components.schemas.ApplyChangesRequest);
});

test("private actions require API key", async () => {
  const res = await worker.fetch(req("/v1/repository/inspect", { repo: "xiaoqianran/demo" }, "wrong"), envBase);
  assert.equal(res.status, 401);
});

test("inspect repository discovers default branch", async () => {
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo": { default_branch: "dev", private: false, description: "demo", html_url: "https://github.com/xiaoqianran/demo" },
      "GET /repos/xiaoqianran/demo/git/trees/dev?recursive=1": { tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: "a", size: 10 }], truncated: false },
    }),
  };
  const res = await worker.fetch(req("/v1/repository/inspect", { repo: "xiaoqianran/demo" }), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.default_branch, "dev");
  assert.equal(out.ref, "dev");
  assert.equal(out.items[0].path, "src/a.js");
});

test("batch read files decodes base64", async () => {
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo/contents/a.txt?ref=main": { type: "file", path: "a.txt", sha: "a", size: 1, encoding: "base64", content: Buffer.from("A").toString("base64") },
      "GET /repos/xiaoqianran/demo/contents/b.txt?ref=main": { type: "file", path: "b.txt", sha: "b", size: 1, encoding: "base64", content: Buffer.from("B").toString("base64") },
    }),
  };
  const res = await worker.fetch(req("/v1/files/read", { repo: "xiaoqianran/demo", ref: "main", paths: ["a.txt", "b.txt"] }), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).files.map((f) => f.content), ["A", "B"]);
});

test("sensitive reads are blocked", async () => {
  const res = await worker.fetch(req("/v1/files/read", { repo: "xiaoqianran/demo", ref: "main", paths: [".env"] }), envBase);
  assert.equal(res.status, 403);
});

test("code search is scoped to allowed repository", async () => {
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /search/code?q=needle+repo%3Axiaoqianran%2Fdemo&per_page=5": { total_count: 1, items: [{ name: "a.js", path: "src/a.js", sha: "x", html_url: "https://github.com/xiaoqianran/demo/blob/main/src/a.js", text_matches: [] }] },
    }),
  };
  const res = await worker.fetch(req("/v1/code/search", { repo: "xiaoqianran/demo", query: "needle", limit: 5 }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items[0].path, "src/a.js");
});

test("apply changes creates branch, atomic commit and draft PR", async () => {
  let refPatch;
  let prBody;
  let branchReads = 0;
  const baseFetch = mockFetch({
    "GET /repos/xiaoqianran/demo": { default_branch: "main" },
    "GET /repos/xiaoqianran/demo/git/ref/heads/main": { object: { sha: "main1" } },
    "POST /repos/xiaoqianran/demo/git/refs": { object: { sha: "main1" } },
    "GET /repos/xiaoqianran/demo/git/commits/main1": { tree: { sha: "tree0" } },
    "POST /repos/xiaoqianran/demo/git/blobs": { sha: "blob1" },
    "POST /repos/xiaoqianran/demo/git/trees": { sha: "tree1" },
    "POST /repos/xiaoqianran/demo/git/commits": { sha: "commit1" },
    "PATCH /repos/xiaoqianran/demo/git/refs/heads/mygpt%2Ffix": (init) => { refPatch = JSON.parse(init.body); return { object: { sha: "commit1" } }; },
    "GET /repos/xiaoqianran/demo/pulls?state=open&head=xiaoqianran%3Amygpt%2Ffix&base=main": [],
    "POST /repos/xiaoqianran/demo/pulls": (init) => { prBody = JSON.parse(init.body); return { number: 3, html_url: "https://github.com/xiaoqianran/demo/pull/3", state: "open", draft: true }; },
  });
  const env = {
    ...envBase,
    __fetch: async (url, init = {}) => {
      const u = new URL(url);
      if ((init.method || "GET") === "GET" && u.pathname === "/repos/xiaoqianran/demo/git/ref/heads/mygpt%2Ffix") {
        branchReads += 1;
        if (branchReads === 1) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ object: { sha: "main1" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return baseFetch(url, init);
    },
  };

  const res = await worker.fetch(req("/v1/changes/apply", {
    repo: "xiaoqianran/demo",
    branch: "mygpt/fix",
    message: "fix: demo",
    changes: [{ path: "src/a.js", content: "export const a = 1;\n" }],
    pull_request: { title: "Fix demo" },
  }), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.branch_created, true);
  assert.equal(out.commit_sha, "commit1");
  assert.equal(out.pull_request.number, 3);
  assert.deepEqual(refPatch, { sha: "commit1", force: false });
  assert.equal(prBody.draft, true);
});

test("apply changes blocks direct main and workflow writes", async () => {
  const main = await worker.fetch(req("/v1/changes/apply", {
    repo: "xiaoqianran/demo", branch: "main", message: "x", changes: [{ path: "a.txt", content: "x" }],
  }), envBase);
  assert.equal(main.status, 403);

  const workflow = await worker.fetch(req("/v1/changes/apply", {
    repo: "xiaoqianran/demo", branch: "mygpt/x", message: "x", changes: [{ path: ".github/workflows/pwn.yml", content: "x" }],
  }), envBase);
  assert.equal(workflow.status, 403);
});

test("expected head mismatch returns 409", async () => {
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo": { default_branch: "main" },
      "GET /repos/xiaoqianran/demo/git/ref/heads/mygpt%2Fx": { object: { sha: "new-head" } },
    }),
  };
  const res = await worker.fetch(req("/v1/changes/apply", {
    repo: "xiaoqianran/demo", branch: "mygpt/x", message: "x", expected_head_sha: "old-head", changes: [{ path: "a.txt", content: "x" }],
  }), env);
  assert.equal(res.status, 409);
});
