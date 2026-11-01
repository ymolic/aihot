// The spec boundary: a stored spec validates once, with its defaults filled here rather than at each
// use, and anything else — an unknown collector, an unknown key, a malformed repository — is refused,
// not ignored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpec } from "../backend/spec.ts";

test("a search spec validates and fills its defaults", () => {
  const spec = parseSpec({ collector: "github_search", queries: ["topic:llm pushed:>{since}"] });
  assert.ok(spec && spec.collector === "github_search");
  assert.equal(spec.perPage, 30);
  assert.equal(spec.lookbackDays, 45);
  assert.equal(spec.minStars, 0);
  assert.equal(spec.maxReadmes, 12);
});

test("unknown keys and wrong shapes are refused", () => {
  assert.equal(parseSpec({ collector: "github_search", queries: ["x"], fetchFullText: true }), null);
  assert.equal(parseSpec({ collector: "npm_packages", packages: ["left-pad"] }), null);
  assert.equal(parseSpec({ collector: "github_releases", repos: ["not-a-repo"] }), null);
  assert.equal(parseSpec({ collector: "github_releases", repos: [] }), null);
  assert.equal(parseSpec(null), null);
  assert.equal(parseSpec(undefined), null);
});

test("a releases and a hacker news spec validate", () => {
  assert.ok(parseSpec({ collector: "github_releases", repos: ["ollama/ollama"] }));
  const hn = parseSpec({ collector: "hacker_news" });
  assert.ok(hn && hn.collector === "hacker_news");
  assert.equal(hn.minScore, 30);
  assert.equal(hn.maxItems, 40);
});
