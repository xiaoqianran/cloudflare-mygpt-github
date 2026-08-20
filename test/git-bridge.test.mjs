import test from "node:test";
import assert from "node:assert/strict";
import worker, { parseGitRoute } from "../src/index.js";

const envBase = {
  GPT_API_KEY: "test-gpt-key",
  GIT_GATEWAY_TOKEN: "test-git-gateway-key",
  GITHUB_TOKEN: "test-github-token",
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

test("upload-pack is streamed and client credentials are replaced with GitHub credentials", async () => {
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
    gitRequest("/git/any-owner/any-repo.git/info/refs?service=git-upload-pack", {
      headers: { "git-protocol": "version=2" },
    }),
    env,
  );

  assert.equal(res.status, 200);
  assert.equal(seenUrl, "https://github.com/any-owner/any-repo.git/info/refs?service=git-upload-pack");
  assert.equal(seenInit.headers.get("git-protocol"), "version=2");
  assert.equal(
    seenInit.headers.get("authorization"),
    `Basic ${Buffer.from("x-access-token:test-github-token").toString("base64")}`,
  );
  assert.notEqual(seenInit.headers.get("authorization"), basic());
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), upstreamBytes);
});

test("receive-pack advertisement is always enabled", async () => {
  let seenUrl;
  const env = {
    ...envBase,
    __gitFetch: async (url) => {
      seenUrl = url;
      return new Response("advertisement", {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-advertisement" },
      });
    },
  };

  const res = await worker.fetch(
    gitRequest("/git/xiaoqianran/demo.git/info/refs?service=git-receive-pack"),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(seenUrl, "https://github.com/xiaoqianran/demo.git/info/refs?service=git-receive-pack");
});

test("receive-pack request is forwarded byte-for-byte without ref policy inspection", async () => {
  const original = Buffer.from("arbitrary-git-receive-pack-binary-body\0\x01\x02", "binary");
  let forwarded;
  let seenUrl;
  let seenContentEncoding;
  const env = {
    ...envBase,
    __gitFetch: async (url, init) => {
      seenUrl = url;
      seenContentEncoding = init.headers.get("content-encoding");
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
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        "content-encoding": "identity",
      },
    }),
    env,
  );

  assert.equal(res.status, 200);
  assert.equal(seenUrl, "https://github.com/xiaoqianran/demo.git/git-receive-pack");
  assert.equal(seenContentEncoding, "identity");
  assert.deepEqual(forwarded, original);
});

test("gateway does not block main, tags, deletes, or force-style ref updates", async () => {
  const payloads = [
    "push-main",
    "push-tag",
    "delete-branch",
    "force-update",
  ];
  const forwarded = [];
  const env = {
    ...envBase,
    __gitFetch: async (_url, init) => {
      forwarded.push(await new Response(init.body).text());
      return new Response("ok", { status: 200 });
    },
  };

  for (const payload of payloads) {
    const res = await worker.fetch(
      gitRequest("/git/xiaoqianran/demo.git/git-receive-pack", {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/x-git-receive-pack-request" },
      }),
      env,
    );
    assert.equal(res.status, 200);
  }

  assert.deepEqual(forwarded, payloads);
});
