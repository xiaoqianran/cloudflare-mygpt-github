import test from "node:test";
import assert from "node:assert/strict";
import worker, { openApi, matchesRepoPattern } from "../src/index.js";

const envBase = {
  GPT_API_KEY: "test-gpt-key",
  GITHUB_TOKEN: "test-github-token",
  ALLOWED_REPOS: "xiaoqianran/*",
  WRITE_BRANCH_PREFIX: "mygpt/",
};

function req(path, body, key = "test-gpt-key", method = "POST") {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: method === "POST" ? JSON.stringify(body) : undefined,
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

test("repo allowlist patterns", () => {
  assert.equal(matchesRepoPattern("xiaoqianran/demo", "xiaoqianran/*"), true);
  assert.equal(matchesRepoPattern("other/demo", "xiaoqianran/*"), false);
});

test("health and OpenAPI are public", async () => {
  const health = await worker.fetch(new Request("https://gateway.example/health"), {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const spec = openApi("https://gateway.example");
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/v1/commit"]);
  assert.equal(spec.servers[0].url, "https://gateway.example");
});

test("private endpoints require API key", async () => {
  const res = await worker.fetch(req("/v1/tree", { repo: "xiaoqianran/demo" }, "wrong"), envBase);
  assert.equal(res.status, 401);
});

test("read file decodes GitHub base64", async () => {
  const content = "hello 世界\n";
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo/contents/README.md?ref=main": { path: "README.md", sha: "blob1", size: content.length, encoding: "base64", content: b64 },
    }),
  };
  const res = await worker.fetch(req("/v1/files/read", { repo: "xiaoqianran/demo", path: "README.md" }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content, content);
});

test("direct writes to main are blocked", async () => {
  const res = await worker.fetch(req("/v1/commit", {
    repo: "xiaoqianran/demo", branch: "main", message: "bad", changes: [{ path: "a.txt", content: "x" }],
  }), envBase);
  assert.equal(res.status, 403);
});

test("sensitive workflow paths are blocked", async () => {
  const res = await worker.fetch(req("/v1/commit", {
    repo: "xiaoqianran/demo", branch: "mygpt/change", message: "bad", changes: [{ path: ".github/workflows/pwn.yml", content: "x" }],
  }), envBase);
  assert.equal(res.status, 403);
});

test("atomic commit builds blob tree commit and fast-forward ref", async () => {
  let patchBody;
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo/git/ref/heads/mygpt%2Fchange": { object: { sha: "head1" } },
      "GET /repos/xiaoqianran/demo/git/commits/head1": { tree: { sha: "tree0" } },
      "POST /repos/xiaoqianran/demo/git/blobs": (init) => ({ sha: JSON.parse(init.body).content === "new" ? "blob-new" : "blob-other" }),
      "POST /repos/xiaoqianran/demo/git/trees": { sha: "tree1" },
      "POST /repos/xiaoqianran/demo/git/commits": { sha: "commit1" },
      "PATCH /repos/xiaoqianran/demo/git/refs/heads/mygpt%2Fchange": (init) => { patchBody = JSON.parse(init.body); return { object: { sha: "commit1" } }; },
    }),
  };
  const res = await worker.fetch(req("/v1/commit", {
    repo: "xiaoqianran/demo",
    branch: "mygpt/change",
    message: "feat: change",
    expected_head_sha: "head1",
    changes: [{ path: "a.txt", content: "new" }, { path: "old.txt", delete: true }],
  }), env);
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.commit_sha, "commit1");
  assert.deepEqual(patchBody, { sha: "commit1", force: false });
});

test("expected head mismatch returns 409", async () => {
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo/git/ref/heads/mygpt%2Fchange": { object: { sha: "new-head" } },
    }),
  };
  const res = await worker.fetch(req("/v1/commit", {
    repo: "xiaoqianran/demo",
    branch: "mygpt/change",
    message: "feat: change",
    expected_head_sha: "old-head",
    changes: [{ path: "a.txt", content: "new" }],
  }), env);
  assert.equal(res.status, 409);
});

test("create branch and draft PR", async () => {
  let prBody;
  const env = {
    ...envBase,
    __fetch: mockFetch({
      "GET /repos/xiaoqianran/demo/git/ref/heads/main": { object: { sha: "mainsha" } },
      "POST /repos/xiaoqianran/demo/git/refs": { object: { sha: "mainsha" } },
      "POST /repos/xiaoqianran/demo/pulls": (init) => { prBody = JSON.parse(init.body); return { number: 7, html_url: "https://github.com/xiaoqianran/demo/pull/7", state: "open", draft: true }; },
    }),
  };
  const branch = await worker.fetch(req("/v1/branches", { repo: "xiaoqianran/demo", branch: "mygpt/test" }), env);
  assert.equal(branch.status, 201);

  const pr = await worker.fetch(req("/v1/pulls", { repo: "xiaoqianran/demo", head: "mygpt/test", title: "Test PR" }), env);
  assert.equal(pr.status, 201);
  assert.equal((await pr.json()).number, 7);
  assert.equal(prBody.draft, true);
});
