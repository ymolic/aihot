// Candidate → material, the module's renderings of what it fetched: a repository is discovered now
// (its push date rides in raw), a release keeps its own time, an HN hit keeps its link and points,
// and everything names the module as its via and carries the shared raw contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchMaterial, releaseMaterial, hnMaterial } from "../backend/collect.ts";
import type { RepoCandidate } from "../backend/github.ts";
import type { HnHit } from "../backend/hackernews.ts";

const now = new Date("2026-11-02T08:00:00Z");
const candidate: RepoCandidate = {
  repo: "ollama/ollama",
  url: "https://github.com/ollama/ollama",
  description: "Get up and running with large language models.",
  stars: 90_000,
  forks: 7_000,
  language: "Go",
  topics: ["llm"],
  pushedAt: new Date("2026-11-01T20:00:00Z"),
  createdAt: new Date("2023-06-26T00:00:00Z"),
};

const sparkOf = (material: { raw?: unknown }) => (material.raw as { sparkGithub: Record<string, unknown> }).sparkGithub;

test("a search candidate is one article per repository, discovered now, authored by its owner", () => {
  const material = searchMaterial("src", candidate, { query: "topic:llm stars:>=1000 pushed:>{since}", bodyText: "# Ollama\nA README.", trend: { score: 61, basis: "24h" }, now });
  assert.equal(material.title, "ollama/ollama");
  assert.equal(material.url, "https://github.com/ollama/ollama");
  assert.equal(material.author, "ollama");
  assert.equal(material.publishedAt, now); // the discovery time, never the last push
  assert.equal(material.bodyText, "# Ollama\nA README.");
  assert.equal(material.excerpt, candidate.description);
  assert.equal(material.via, "spark-github");
  const spark = sparkOf(material);
  assert.equal(spark.collector, "github_search");
  assert.equal(spark.query, "topic:llm stars:>=1000 pushed:>{since}");
  assert.equal(spark.stars, 90_000);
  assert.equal(spark.forks, 7_000);
  assert.equal(spark.language, "Go");
  assert.deepEqual(spark.topics, ["llm"]);
  assert.equal(spark.pushedAt, "2026-11-01T20:00:00.000Z");
  assert.equal(spark.trendScore, 61);
  assert.equal(spark.trendBasis, "24h");
});

test("without a README the description is the body, and both the trend and the query are optional", () => {
  const material = searchMaterial("src", candidate, { query: "", bodyText: null, trend: null, now });
  assert.equal(material.bodyText, candidate.description);
  const spark = sparkOf(material);
  assert.equal("trendScore" in spark, false);
  assert.equal("query" in spark, false);
});

test("a README longer than the limit is truncated to 4000 characters", () => {
  const material = searchMaterial("src", candidate, { query: "q", bodyText: "a".repeat(5000), trend: null, now });
  assert.ok((material.bodyText ?? "").length <= 4000);
});

test("a release keeps its own time, and its notes arrive as text without the markdown furniture", () => {
  const material = releaseMaterial("src", {
    repo: "vllm-project/vllm",
    url: "https://github.com/vllm-project/vllm/releases/tag/v0.11.0",
    name: "v0.11.0",
    tagName: "v0.11.0",
    body: "# Highlights\n![logo](https://x/y.png)\nSee [the docs](https://docs.vllm.ai).",
    publishedAt: new Date("2026-10-30T10:00:00Z"),
    prerelease: false,
  });
  assert.equal(material.title, "vllm-project/vllm v0.11.0");
  assert.equal(material.publishedAt?.toISOString(), "2026-10-30T10:00:00.000Z");
  const body = material.bodyText ?? "";
  assert.ok(!body.includes("![logo]"));
  assert.ok(!body.includes("](https"));
  assert.ok(body.includes("See the docs"));
  assert.equal(sparkOf(material).collector, "github_releases");
});

test("an HN hit keeps its own link, its points and its story text as the body", () => {
  // fetchFrontPage hands the story text over as plain text (its tags are stripped there).
  const material = hnMaterial("src", {
    id: "40000",
    title: "Show HN: I built an AI agent for code review",
    url: "https://example.com/tool",
    text: "It reads diffs & comments.",
    author: "someone",
    points: 120,
    comments: 44,
    createdAt: new Date("2026-11-02T06:00:00Z"),
  });
  assert.equal(material.url, "https://example.com/tool");
  assert.equal(material.bodyText, "It reads diffs & comments.");
  assert.equal(material.author, "someone");
  const spark = sparkOf(material);
  assert.equal(spark.collector, "hacker_news");
  assert.equal(spark.hnPoints, 120);
  assert.equal(spark.hnComments, 44);
});

test("a link post without story text ships without a body: the engine extracts the linked page", () => {
  const material = hnMaterial("src", { id: "40001", title: "OpenAI publishes new research", url: "https://openai.com/index/research", text: null, author: null, points: 55, comments: 10, createdAt: null });
  assert.equal(material.bodyText, null);
  assert.equal(material.publishedAt, null);
});
