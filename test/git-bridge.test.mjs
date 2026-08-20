import test from "node:test";
import assert from "node:assert/strict";
import worker, { parseGitRoute } from "../src/index.js";

const envBase = {
  GPT_API_KEY: "test-gpt-key",
  GIT_GATEWAY_TOKEN: "test-git-gateway-key",
  GITHUB_TOKEN: "test-github-token",
  ALLOWED_REPOS: "xiaoqianran/*",
  WRITE_BRANCH_PREFIX: "mygpt/",
  ENABLE_GIT_PUSH: "false",
};

function basic(token = envBase.GIT_GATEWAY_TOKEN, username = "git") {
  return `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

function gitRequest(path, { method = "GET", body, token, headers = {} } = {}) {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: {
      authorization: basic(token),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
}

function pktLine(payload) {
  const bytes = Buffer.from(payload, "utf8");
  const length = (bytes.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "ascii"), bytes]);
}

function receivePackBody(ref) {
  const oldSha = "0".repeat(40);
  const newSha = "1".repeat(40);
  const command = pktLine(`${oldSha} ${newSha} ${ref}\0report-status side-band-64k\n`);
  return Buffer.concat([command, Buffer.from("0000", "ascii"), Buffer.from("PACKfake", "ascii")]);
}

test("git bridge route parser only accepts Smart HTTP endpoints", () => {
  assert.deepEqual(parseGitRoute("/git/xiaoqianran/demo.git/info/refs"), {
    repo: "xiaoqianran/demo",
    endpoint: "info/refs",
  });
  assert.equal(parseGitRoute("/git/xiaoqianran/demo/archive.zip"), null);
});

test("native Git gets a Basic-auth challenge", async () => {
  const req = new Request(
    "https://gateway.example/git/xiaoqianran/demo.git/info/refs?service=git-upload-pack",
  );
  const res = await worker.fetch(req, envBase);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /^Basic /);
});

test("upload-pack advertisement is streamed through GitHub without leaking client credentials", async () => {
  let seenUrl;
  let seenInit;
  const upstreamBytes = Uint8Array.from([0x30, 0x30, 0x30, 0x38, 0x4e, 0x41, 0x4b, 0x0a]);
  const env = {
    ...envBase,
    __gitFetch: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(upstreamBytes, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    },
  };

  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/info/refs?service=git-upload-pack", {
      headers: { "git-protocol": "version=2" },
    }),
    env,
  );

  assert.equal(res.status, 200);
  assert.equal(seenUrl, "https://github.com/xiaoqianran/demo.git/info/refs?service=git-upload-pack");
  assert.equal(seenInit.headers.get("git-protocol"), "version=2");
  assert.equal(
    seenInit.headers.get("authorization"),
    `Basic ${Buffer.from("x-access-token:test-github-token").toString("base64")}`,
  );
  assert.notEqual(seenInit.headers.get("authorization"), basic());
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), upstreamBytes);
});

test("git receive-pack is disabled by default", async () => {
  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/info/refs?service=git-receive-pack"),
    envBase,
  );
  assert.equal(res.status, 403);
});

test("git push cannot update main even when native push is enabled", async () => {
  const env = { ...envBase, ENABLE_GIT_PUSH: "true" };
  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/git-receive-pack", {
      method: "POST",
      body: receivePackBody("refs/heads/main"),
      headers: { "content-type": "application/x-git-receive-pack-request" },
    }),
    env,
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /refs\/heads\/mygpt\//);
});

test("mygpt branch push is inspected then streamed unchanged", async () => {
  const original = receivePackBody("refs/heads/mygpt/local-test");
  let forwarded;
  let seenUrl;
  const env = {
    ...envBase,
    ENABLE_GIT_PUSH: "true",
    __gitFetch: async (url, init) => {
      seenUrl = url;
      forwarded = Buffer.from(await new Response(init.body).arrayBuffer());
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    },
  };

  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/git-receive-pack", {
      method: "POST",
      body: original,
      headers: { "content-type": "application/x-git-receive-pack-request" },
    }),
    env,
  );

  assert.equal(res.status, 200);
  assert.equal(seenUrl, "https://github.com/xiaoqianran/demo.git/git-receive-pack");
  assert.deepEqual(forwarded, original);
});

test("git branch deletion through receive-pack is blocked", async () => {
  const oldSha = "1".repeat(40);
  const newSha = "0".repeat(40);
  const command = pktLine(`${oldSha} ${newSha} refs/heads/mygpt/delete-me\0report-status\n`);
  const body = Buffer.concat([command, Buffer.from("0000", "ascii")]);
  const env = { ...envBase, ENABLE_GIT_PUSH: "true" };
  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/git-receive-pack", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-git-receive-pack-request" },
    }),
    env,
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /deletion/);
});
