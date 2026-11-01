// The module's collection run, one spark_github_specs row (with its external source) per pass. Search
// results become snapshot rows (the trend history) and then materials; releases and HN hits become
// materials. Material storage goes through upsertMaterial, the engine's single entrance, and every
// created or revised article is handed on with queueProcessing, exactly as the engine's own collectors
// do — the engine never collects an external source itself (sources/collect.ts skips the kind), so
// this run is the only thing that fills them. Each pass leaves a fetch_runs row, the trail the
// engine's sources write, and the GitHub budget state survives in the spec's cursor.
import { sql } from "@aihot/backend/db";
import { upsertMaterial, type MaterialInput } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { truncate } from "@aihot/backend/lib/text";
import { fetchFrontPage, type HnHit } from "./hackernews.ts";
import {
  fetchReadme, latestRelease, markdownToText, RateLimitedError, searchRepos,
  type RateLimitState, type ReleaseCandidate, type RepoCandidate,
} from "./github.ts";
import { parseSpec, type SparkGithubSpec } from "./spec.ts";
import { githubTrend, growthWindows, DAY_MS, type Snapshot, type TrendScore } from "./trend.ts";

/** The material's provenance (articles.raw.sparkGithub), the shared contract with the industry pack. */
export interface SparkGithubRaw {
  collector: "github_search" | "github_releases" | "hacker_news";
  stars?: number;
  forks?: number;
  language?: string | null;
  topics?: string[];
  pushedAt?: string;
  hnPoints?: number;
  hnComments?: number;
  query?: string;
  trendScore?: number;
  trendBasis?: "24h" | "7d" | "cold-start";
}

const VIA = "spark-github";

// ---------------------------------------------------------------------------
// Candidate → material, the module's renderings (pure: the collectors hand over fetched data)
// ---------------------------------------------------------------------------

/** A repository is not news: it is judged at its discovery time, whatever the last push was (the push rides in raw). */
export function searchMaterial(sourceId: string, candidate: RepoCandidate, opts: { query: string; bodyText: string | null; trend: TrendScore | null; now: Date }): MaterialInput {
  const spark: SparkGithubRaw = { collector: "github_search", stars: candidate.stars, forks: candidate.forks };
  if (candidate.language) spark.language = candidate.language;
  if (candidate.topics.length) spark.topics = candidate.topics;
  if (candidate.pushedAt) spark.pushedAt = candidate.pushedAt.toISOString();
  if (opts.query) spark.query = opts.query;
  if (opts.trend) {
    spark.trendScore = opts.trend.score;
    spark.trendBasis = opts.trend.basis;
  }
  const body = opts.bodyText ?? candidate.description;
  return {
    sourceId,
    url: candidate.url,
    title: candidate.repo,
    author: candidate.repo.split("/")[0] ?? null,
    publishedAt: opts.now,
    publicationTime: opts.now.toISOString(),
    excerpt: candidate.description,
    // No README this run: the description stands in, so the article is not judged on its title alone.
    bodyText: body ? truncate(body, 4000) : null,
    raw: { sparkGithub: spark },
    via: VIA,
    discoveredAt: opts.now,
  };
}

/** A release is news at its own time: an old one discovered late arrives as history, as any article would. */
export function releaseMaterial(sourceId: string, release: ReleaseCandidate): MaterialInput {
  const spark: SparkGithubRaw = { collector: "github_releases" };
  return {
    sourceId,
    url: release.url,
    title: `${release.repo} ${release.name ?? release.tagName}`.trim(),
    publishedAt: release.publishedAt,
    publicationTime: release.publishedAt?.toISOString(),
    bodyText: release.body ? truncate(markdownToText(release.body), 4000) : null,
    raw: { sparkGithub: spark },
    via: VIA,
  };
}

export function hnMaterial(sourceId: string, hit: HnHit): MaterialInput {
  const spark: SparkGithubRaw = { collector: "hacker_news", hnPoints: hit.points, hnComments: hit.comments };
  return {
    sourceId,
    url: hit.url,
    title: hit.title,
    author: hit.author,
    publishedAt: hit.createdAt,
    publicationTime: hit.createdAt?.toISOString(),
    bodyText: hit.text,
    raw: { sparkGithub: spark },
    via: VIA,
  };
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

/** Budget and gate state, kept between runs in the spec's cursor. */
interface SpecCursor {
  blockedUntil?: string;
  remaining?: number | null;
  resetAt?: string | null;
  lastRunAt?: string;
}

const readCursor = (value: unknown): SpecCursor => (value && typeof value === "object" && !Array.isArray(value) ? value as SpecCursor : {});

const snapshotsFor = async (repo: string, now: Date): Promise<Snapshot[]> =>
  (await sql<{ stars: number; observed_at: Date }[]>`
    SELECT stars, observed_at FROM spark_github_snapshots WHERE repo = ${repo} AND observed_at < ${now} ORDER BY observed_at`)
    .map(row => ({ stars: row.stars, observedAt: row.observed_at }));

/** Stores one material and hands it on when processing is needed; the counts the run reports. */
async function store(sourceId: string, material: MaterialInput, counts: { created: number; revised: number }): Promise<void> {
  const result = await upsertMaterial(material);
  if (result.created || result.revised || result.processingNeeded) await queueProcessing(result.articleId);
  if (result.created) counts.created += 1;
  if (result.revised) counts.revised += 1;
}

async function collectSearch(
  sourceId: string,
  spec: Extract<SparkGithubSpec, { collector: "github_search" }>,
  cursor: SpecCursor,
  now: Date,
): Promise<Outcome> {
  const { candidates, queries, rate, skippedQueries } = await searchRepos(
    spec,
    { remaining: cursor.remaining ?? null, resetAt: cursor.resetAt ? new Date(cursor.resetAt) : null },
    now,
  );
  // The observation first: the trend reads this run's own rows like any older one.
  if (candidates.length) {
    await sql`INSERT INTO spark_github_snapshots ${sql(candidates.map(c => ({ repo: c.repo, stars: c.stars, forks: c.forks, observed_at: now })))}
      ON CONFLICT (repo, observed_at) DO NOTHING`;
  }
  // The repository's html_url is its identity: one article per repository, and a repository already
  // stored is a discovery only. Its README is fetched again just when the stored article still has
  // no body (a past fetch failed) — and within the run's budget.
  const identities = candidates.map(c => identityKeyForUrl(c.url)).filter((key): key is string => !!key);
  const stored = new Map(
    identities.length
      ? (await sql<{ identity_key: string; has_body: boolean }[]>`
          SELECT identity_key, body_text IS NOT NULL AS has_body FROM articles WHERE identity_key = ANY(${identities}::text[])`)
          .map(row => [row.identity_key, row.has_body])
      : [],
  );
  const counts = { created: 0, revised: 0 };
  let readmes = 0;
  for (const candidate of candidates) {
    const identity = identityKeyForUrl(candidate.url)!;
    let bodyText: string | null = null;
    if (stored.get(identity) !== true && readmes < spec.maxReadmes) {
      bodyText = await fetchReadme(candidate.repo);
      readmes += 1;
    }
    const history = await snapshotsFor(candidate.repo, now);
    const trend = githubTrend({
      stars: candidate.stars,
      forks: candidate.forks,
      ageDays: candidate.createdAt ? Math.max(0, (now.getTime() - candidate.createdAt.getTime()) / DAY_MS) : NaN,
      daysSincePush: candidate.pushedAt ? Math.max(0, (now.getTime() - candidate.pushedAt.getTime()) / DAY_MS) : NaN,
      ...growthWindows(history, candidate.stars, now),
    });
    await store(sourceId, searchMaterial(sourceId, candidate, {
      query: queries.get(candidate.repo) ?? "",
      bodyText,
      trend,
      now,
    }), counts);
  }
  return {
    found: candidates.length,
    ...counts,
    rate,
    detail: { readmes, skippedQueries, queries: spec.queries.length },
  };
}

async function collectReleases(sourceId: string, spec: Extract<SparkGithubSpec, { collector: "github_releases" }>): Promise<Outcome> {
  const counts = { created: 0, revised: 0 };
  let found = 0;
  for (const repo of spec.repos) {
    const release = await latestRelease(repo);
    if (!release) continue;
    found += 1;
    await store(sourceId, releaseMaterial(sourceId, release), counts);
  }
  return { found, ...counts, detail: { repos: spec.repos.length } };
}

async function collectHackerNews(sourceId: string, spec: Extract<SparkGithubSpec, { collector: "hacker_news" }>): Promise<Outcome> {
  const hits = await fetchFrontPage(spec);
  const counts = { created: 0, revised: 0 };
  for (const hit of hits) await store(sourceId, hnMaterial(sourceId, hit), counts);
  return { found: hits.length, ...counts, detail: { minScore: spec.minScore } };
}

interface Outcome {
  found: number;
  created: number;
  revised: number;
  /** The budget after the run; kept for the next one (absent for the collectors that need no token). */
  rate?: RateLimitState;
  detail?: Record<string, unknown>;
}

export interface CollectResult {
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
  detail?: Record<string, unknown>;
}

/** One source's collection pass: what the module's cron runs, and what the admin's manual fetch runs. */
export async function collectSource(sourceId: string, opts: { force?: boolean } = {}, now = new Date()): Promise<CollectResult> {
  const [row] = await sql<{ collector: string; spec: unknown; cursor: unknown; spec_enabled: boolean; source_enabled: boolean }[]>`
    SELECT s.collector, s.spec, s.cursor, s.enabled AS spec_enabled, src.enabled AS source_enabled
    FROM spark_github_specs s JOIN sources src ON src.id = s.source_id WHERE s.source_id = ${sourceId}`;
  if (!row) return { status: "skipped", found: 0, created: 0, revised: 0, error: "no spec" };
  if (!row.spec_enabled || (!row.source_enabled && !opts.force)) return { status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  const spec = parseSpec(row.spec);
  if (!spec) return { status: "skipped", found: 0, created: 0, revised: 0, error: "invalid spec" };
  const cursor = readCursor(row.cursor);
  if (cursor.blockedUntil && new Date(cursor.blockedUntil) > now) {
    return { status: "skipped", found: 0, created: 0, revised: 0, detail: { blockedUntil: cursor.blockedUntil } };
  }
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  try {
    const outcome = spec.collector === "github_search" ? await collectSearch(sourceId, spec, cursor, now)
      : spec.collector === "github_releases" ? await collectReleases(sourceId, spec)
        : await collectHackerNews(sourceId, spec);
    await saveCursor(sourceId, {
      ...cursor,
      remaining: outcome.rate ? outcome.rate.remaining : null,
      resetAt: outcome.rate?.resetAt?.toISOString() ?? null,
      blockedUntil: undefined,
      lastRunAt: now.toISOString(),
    });
    await finishRun(run.id, "ok", outcome, null);
    return { status: "ok", found: outcome.found, created: outcome.created, revised: outcome.revised, detail: outcome.detail };
  } catch (error) {
    // The budget's gate: nothing runs again before the reset, whatever the cron says.
    const resetAt = error instanceof RateLimitedError ? error.resetAt : null;
    if (resetAt) await saveCursor(sourceId, { ...cursor, blockedUntil: resetAt.toISOString(), lastRunAt: now.toISOString() });
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await finishRun(run.id, "failed", { found: 0, created: 0, revised: 0 }, message);
    return { status: "failed", found: 0, created: 0, revised: 0, error: message };
  }
}

async function saveCursor(sourceId: string, cursor: SpecCursor): Promise<void> {
  await sql`UPDATE spark_github_specs SET cursor = ${sql.json(cursor as never)}, updated_at = now() WHERE source_id = ${sourceId}`;
}

async function finishRun(runId: number, status: "ok" | "failed", outcome: Outcome, error: string | null): Promise<void> {
  await sql`UPDATE fetch_runs SET status = ${status}, finished_at = now(), found_count = ${outcome.found}, new_count = ${outcome.created},
    error = ${error}, detail = ${outcome.detail ? sql.json(outcome.detail as never) : null} WHERE id = ${runId}`;
}

/** The module's cron: every enabled spec of every enabled source, one after another. */
export async function collectAll(now = new Date()): Promise<Record<string, unknown>> {
  const specs = await sql<{ source_id: string }[]>`
    SELECT s.source_id FROM spark_github_specs s JOIN sources src ON src.id = s.source_id
    WHERE s.enabled AND src.enabled ORDER BY s.source_id`;
  let ok = 0, failed = 0, skipped = 0, created = 0, revised = 0;
  const failures: Record<string, string> = {};
  for (const { source_id } of specs) {
    const result = await collectSource(source_id, {}, now);
    if (result.status === "ok") {
      ok += 1;
      created += result.created;
      revised += result.revised;
    } else if (result.status === "failed") {
      failed += 1;
      failures[source_id] = result.error ?? "unknown";
    } else skipped += 1;
  }
  return { sources: specs.length, ok, failed, skipped, created, revised, ...(Object.keys(failures).length ? { failures } : {}) };
}

/** The module's share of the daily retention run: snapshots past the trend windows' horizon. */
export async function retention(): Promise<Record<string, unknown>> {
  const rows = await sql`DELETE FROM spark_github_snapshots WHERE observed_at < now() - interval '30 days' RETURNING repo`;
  return { sparkGithubSnapshots: rows.count };
}
