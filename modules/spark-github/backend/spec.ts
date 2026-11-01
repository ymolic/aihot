// The spec a spark-github source carries (spark_github_specs.spec). The sources are kind='external',
// whose sources.config whitelist admits publisher keys only, so the collector's own parameters live
// here, validated once at the boundary and defaulted here rather than at each use.
import { z } from "zod";

export const COLLECTORS = ["github_search", "github_releases", "hacker_news"] as const;
export type Collector = (typeof COLLECTORS)[number];

/** A repository search: recent pushes matching queries, whose material is the README. */
const SearchSpec = z.strictObject({
  collector: z.literal("github_search"),
  queries: z.array(z.string().trim().min(1)).min(1).max(10),
  /** A query may carry its own `sort:` clause (stripped before the request); these are the defaults. */
  sort: z.enum(["updated", "stars", "forks", "help-wanted-issues"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  perPage: z.number().int().min(1).max(100).default(30),
  /** The `{since}` placeholder in a query becomes this many days ago (a date, UTC). */
  lookbackDays: z.number().int().min(1).max(365).default(45),
  minStars: z.number().int().min(0).default(0),
  /** README fetches per run: they share the token's core quota with the release collector. */
  maxReadmes: z.number().int().min(1).max(50).default(12),
});

/** A watchlist: the newest published release of each repository, one material per release. */
const ReleasesSpec = z.strictObject({
  collector: z.literal("github_releases"),
  repos: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/, "owner/repository")).min(1).max(50),
});

/** Hacker News' front page: stories at or above a score, kept to the module's AI terms. */
const HackerNewsSpec = z.strictObject({
  collector: z.literal("hacker_news"),
  minScore: z.number().int().min(0).default(30),
  maxItems: z.number().int().min(1).max(60).default(40),
});

export const SparkGithubSpec = z.discriminatedUnion("collector", [SearchSpec, ReleasesSpec, HackerNewsSpec]);
export type SparkGithubSpec = z.infer<typeof SparkGithubSpec>;

/** Null when the stored spec does not validate (an old shape, a hand edit): the source is skipped, visibly, in its run detail. */
export function parseSpec(value: unknown): SparkGithubSpec | null {
  const parsed = SparkGithubSpec.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}
