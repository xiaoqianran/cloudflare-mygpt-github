import test from "node:test";
import assert from "node:assert/strict";
import { buildFtsQuery } from "../src/mirror.js";

test("mirror FTS query tokenizes code-oriented search safely", () => {
  assert.equal(buildFtsQuery("GitHub authorization token"), '"GitHub" OR "authorization" OR "token"');
  assert.equal(buildFtsQuery("foo foo bar"), '"foo" OR "bar"');
  assert.equal(buildFtsQuery("  "), "");
});

test("mirror FTS query keeps unicode terms", () => {
  assert.equal(buildFtsQuery("仓库 搜索"), '"仓库" OR "搜索"');
});
