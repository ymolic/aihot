// The GitHub collectors (ported from spark-radar's source-adapters onto the engine's guardedFetch, so
// the egress and SSRF rules keep applying): a repository search whose material is the README, and a
// watchlist's newest release. Both share the token's budget; each response's rate-limit headers are
// returned to the caller, and a refused request raises RateLimitedError with the reset time so the
// run stops and the spec's cursor holds the gate until it passes.
import { credential } from "@aihot/backend/config";
import { guardedFetch, HttpStatusError, type GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { collapseWhitespace, truncate } from "@aihot/backend/lib/text";
import type { SparkGithubSpec } from "./spec.ts";

const API = "https://api.github.com";

export interface RateLimitState {
  /** Remaining requests in the current window; null when the response carried no header. */
  remaining: number | null;
  resetAt: Date | null;
}

export class RateLimitedError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`GitHub API rate limited until ${resetAt.toISOString()}`);
    this.resetAt = resetAt;
  }
}

/** Kept small, so a burst of runs cannot empty the window: below it the remaining queries wait. */
const RATE_RESERVE = 2;

function headers(accept: string): Record<string, string> {
  const out: Record<string, string> = { accept, "X-GitHub-Api-Version": "2022-11-28" };
  const token = credential("collectors", "GITHUB_TOKEN");
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

function rateLimitOf(res: GuardedResponse): RateLimitState {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetSeconds = Number(res.headers.get("x-ratelimit-reset") || 0);
  return {
    remaining: remaining === null ? null : Number(remaining),
    resetAt: resetSeconds > 0 ? new Date(resetSeconds * 1000) : null,
  };
}

/** A refused or exhausted budget: the reset header when the response carries one, else a short wait. */
function refused(res: GuardedResponse): RateLimitedError {
  const { resetAt } = rateLimitOf(res);
  return new RateLimitedError(resetAt ?? new Date(Date.now() + 60_000));
}

const date = (value: unknown): Date | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

export interface RepoCandidate {
  /** "owner/repository", also the material's title. */
  repo: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  pushedAt: Date | null;
  createdAt: Date | null;
}

export interface SearchOutcome {
  candidates: RepoCandidate[];
  /** The first query that listed each repository, for the material's raw. */
  queries: Map<string, string>;
  rate: RateLimitState;
  /** Queries not run because the budget had drained below its reserve. */
  skippedQueries: string[];
}

/** One search request per query; the repos repeat across queries once. */
export async function searchRepos(
  spec: Extract<SparkGithubSpec, { collector: "github_search" }>,
  state: RateLimitState,
  now: Date,
): Promise<SearchOutcome> {
  const since = new Date(now.getTime() - spec.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const repos = new Map<string, RepoCandidate>();
  const queries = new Map<string, string>();
  const skippedQueries: string[] = [];
  let rate = state;
  for (const configured of spec.queries) {
    if (rate.remaining !== null && rate.remaining <= RATE_RESERVE) {
      skippedQueries.push(configured);
      continue;
    }
    let query = configured.replaceAll("{since}", since);
    let sort = spec.sort ?? "updated";
    let order = spec.order ?? "desc";
    const inline = /\bsort:(stars|updated|forks|help-wanted-issues)(?:-(asc|desc))?\b/i.exec(query);
    if (inline) {
      sort = inline[1]!.toLowerCase() as typeof sort;
      if (inline[2]) order = inline[2].toLowerCase() as typeof order;
      query = query.replace(inline[0], "").replace(/\s+/g, " ").trim();
    }
    const endpoint = new URL(`${API}/search/repositories`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("sort", sort);
    endpoint.searchParams.set("order", order);
    endpoint.searchParams.set("per_page", String(spec.perPage));
    const res = await guardedFetch(endpoint.toString(), { headers: headers("application/vnd.github+json"), maxBytes: 2_000_000, timeoutMs: 20_000 });
    rate = rateLimitOf(res);
    if (res.status === 403 || res.status === 429) throw refused(res);
    if (res.status !== 200) throw new HttpStatusError(res.status, `GitHub search "${configured}" HTTP ${res.status}`);
    const data = JSON.parse(res.text()) as { items?: unknown };
    if (!Array.isArray(data.items)) throw new Error(`GitHub search "${configured}" returned no item list`);
    for (const item of data.items) {
      const repository = item as Record<string, unknown>;
      const name = typeof repository.full_name === "string" ? repository.full_name : null;
      const url = typeof repository.html_url === "string" ? repository.html_url : null;
      if (!name || !url || repository.archived === true || repository.fork === true) continue;
      const stars = Number(repository.stargazers_count) || 0;
      if (stars < spec.minStars) continue;
      repos.set(name, {
        repo: name,
        url,
        description: typeof repository.description === "string" && repository.description.trim() ? repository.description : null,
        stars,
        forks: Number(repository.forks_count) || 0,
        language: typeof repository.language === "string" ? repository.language : null,
        topics: Array.isArray(repository.topics) ? repository.topics.filter((t): t is string => typeof t === "string").slice(0, 20) : [],
        pushedAt: date(repository.pushed_at),
        createdAt: date(repository.created_at),
      });
      if (!queries.has(name)) queries.set(name, configured);
    }
  }
  return { candidates: [...repos.values()], queries, rate, skippedQueries };
}

/** The README as raw markdown (≤4000 characters); a repository without one, null. */
export async function fetchReadme(repo: string): Promise<string | null> {
  const res = await guardedFetch(`${API}/repos/${repo}/readme`, { headers: headers("application/vnd.github.raw"), maxBytes: 512_000, timeoutMs: 15_000 });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw refused(res);
  if (res.status !== 200) throw new HttpStatusError(res.status, `GitHub readme ${repo} HTTP ${res.status}`);
  const text = res.text().trim();
  return text ? truncate(text, 4000) : null;
}

export interface ReleaseCandidate {
  repo: string;
  /** The release page, the material's URL. */
  url: string;
  name: string | null;
  tagName: string;
  body: string | null;
  publishedAt: Date | null;
  prerelease: boolean;
}

/** The newest published release of one repository (drafts are not published; null when there is none). */
export async function latestRelease(repo: string): Promise<ReleaseCandidate | null> {
  const res = await guardedFetch(`${API}/repos/${repo}/releases?per_page=5`, { headers: headers("application/vnd.github+json"), maxBytes: 1_000_000, timeoutMs: 15_000 });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw refused(res);
  if (res.status !== 200) throw new HttpStatusError(res.status, `GitHub releases ${repo} HTTP ${res.status}`);
  const releases = JSON.parse(res.text()) as unknown;
  if (!Array.isArray(releases)) throw new Error(`GitHub releases ${repo} returned no release list`);
  for (const item of releases) {
    const release = item as Record<string, unknown>;
    if (release.draft === true) continue;
    const url = typeof release.html_url === "string" ? release.html_url : null;
    const tagName = typeof release.tag_name === "string" ? release.tag_name : null;
    if (!url || !tagName) continue;
    return {
      repo,
      url,
      name: typeof release.name === "string" && release.name.trim() ? release.name : null,
      tagName,
      body: typeof release.body === "string" && release.body.trim() ? release.body : null,
      publishedAt: date(release.published_at) ?? date(release.created_at),
      prerelease: release.prerelease === true,
    };
  }
  return null;
}

/** Release notes are markdown; the material wants readable text: images out, links to their text. */
export function markdownToText(markdown: string): string {
  return collapseWhitespace(markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1 ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/<[^>]+>/g, " "));
}
