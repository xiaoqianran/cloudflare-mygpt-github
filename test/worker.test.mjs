import test from "node:test";
import assert from "node:assert/strict";
import worker, { openApi, matchesRepoPattern } from "../src/index.js";

const envBase = {
  GPT_API_KEY: "test-gpt-key",
  GITHUB_TOKEN: "test-github-token",
  ALLOWED_REPOS: "xiaoqianran/*",
  WRITE_BRANCH_PREFIX: "mygpt/",
};

function post(path, body, key = "test-gpt-key") {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

test("repo allowlist wildcard still works", () => {
  assert.equal(matchesRepoPattern("xiaoqianran/demo", "xiaoqianran/*"), true);
  assert.equal(matchesRepoPattern("other/demo", "xiaoqianran/*"), false);
});

test("OpenAPI exposes the v0.5 mirror tool surface", () => {
  const spec = openApi("https://gateway.example");
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.version, "0.5.0");
  assert.equal(spec.servers[0].url, "https://gateway.example");
  assert.ok(spec.components && typeof spec.components === "object");
  assert.ok(spec.components.schemas && typeof spec.components.schemas === "object" && !Array.isArray(spec.components.schemas));
  assert.equal(spec.components.securitySchemes.BearerAuth.type, "http");
  assert.equal(spec.components.securitySchemes.BearerAuth.scheme, "bearer");
  assert.deepEqual(spec.security, [{ BearerAuth: [] }]);
  assert.deepEqual(
    Object.values(spec.paths).map((path) => path.post.operationId).sort(),
    ["applyChanges", "inspectRepository", "readFiles", "readRepositoryPage", "searchRepository", "syncRepository"].sort(),
  );
});

test("health and OpenAPI stay public", async () => {
  const health = await worker.fetch(new Request("https://gateway.example/health"), {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "0.5.0");

  const schema = await worker.fetch(new Request("https://gateway.example/openapi.json"), {});
  assert.equal(schema.status, 200);
  const json = await schema.json();
  assert.ok(json.components.schemas.SyncRepositoryRequest);
  assert.ok(json.paths["/v1/repository/page"]);
});

test("GPT routes require Bearer auth before touching mirror bindings", async () => {
  const res = await worker.fetch(
    post("/v1/repository/inspect", { repo: "xiaoqianran/demo" }, "wrong"),
    envBase,
  );
  assert.equal(res.status, 401);
});

test("legacy X-API-Key is not accepted", async () => {
  const request = new Request("https://gateway.example/v1/repository/inspect", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-gpt-key" },
    body: JSON.stringify({ repo: "xiaoqianran/demo" }),
  });
  const res = await worker.fetch(request, envBase);
  assert.equal(res.status, 401);
});

test("mirror route reports missing binding clearly", async () => {
  const res = await worker.fetch(
    post("/v1/repository/inspect", { repo: "xiaoqianran/demo" }),
    envBase,
  );
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /REPO_DB/);
});
