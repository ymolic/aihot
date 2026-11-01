// A repository's trend score (ported from spark-radar's githubTrend): growth in a window, its
// acceleration, fork quality, push recency and a cold-start estimate, on a 0-100 scale. It is context
// for the editorial scores (raw.sparkGithub.trendScore), never a decision of its own; a repository
// without the numbers it needs scores null and the material ships without it.

export interface GithubTrendInput {
  stars: number;
  forks: number;
  /** The repository's age, days. */
  ageDays: number;
  /** Days since the last push. */
  daysSincePush: number;
  /** Growth over the window, from the snapshots. Null: the window has no observation yet. */
  stars24h?: number | null;
  stars7d?: number | null;
}

export interface TrendScore {
  score: number;
  basis: "24h" | "7d" | "cold-start";
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const logScore = (value: number, scale: number) => Math.min(scale, Math.log10(Math.max(0, value) + 1) * scale * 0.45);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function githubTrend(input: GithubTrendInput): TrendScore | null {
  if (!finite(input.stars) || !finite(input.forks) || !finite(input.ageDays) || !finite(input.daysSincePush)) return null;
  const stars = Math.max(0, input.stars);
  const forks = Math.max(0, input.forks);
  const quality = Math.min(12, Math.log10(forks + 1) * 4) + Math.min(8, (forks / Math.max(stars, 1)) * 80);
  const recency = clamp(12 - input.daysSincePush * 0.4, 0, 12);
  if (input.stars24h != null) {
    const daily = Math.max(0, input.stars24h);
    const weekly = Math.max(0, input.stars7d ?? daily * 7);
    // Above 1 the day outgrew its share of the week: the growth is accelerating.
    const acceleration = daily / Math.max(weekly / 7, 1);
    return { score: clamp(logScore(daily, 22) + logScore(weekly, 10) + Math.min(18, acceleration * 6) + quality + recency), basis: "24h" };
  }
  if (input.stars7d != null) {
    const weekly = Math.max(0, input.stars7d);
    return { score: clamp(logScore(weekly, 18) + quality + recency), basis: "7d" };
  }
  // No window has an observation yet: the repository's own pace stands in for growth.
  const starsPerDay = stars / Math.max(0.25, input.ageDays);
  const freshness = clamp(18 - input.ageDays * 0.22, 0, 18);
  return { score: clamp(logScore(starsPerDay, 24) + logScore(stars, 7) + quality + recency + freshness), basis: "cold-start" };
}

export interface Snapshot {
  stars: number;
  observedAt: Date;
}

/** The stars at the observation nearest the window's start, within tolerance; none, null. */
export function starsAtStart(snapshots: readonly Snapshot[], windowMs: number, toleranceMs: number, now: Date): number | null {
  const start = now.getTime() - windowMs;
  let best: Snapshot | null = null;
  let bestDistance = Infinity;
  for (const snapshot of snapshots) {
    const distance = Math.abs(snapshot.observedAt.getTime() - start);
    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= toleranceMs ? best.stars : null;
}

export const DAY_MS = 86_400_000;
/** A window's observation may be this far from its exact start (runs drift around the cron). */
export const WINDOW_TOLERANCE_MS = 12 * 3600 * 1000;

/** The growth the snapshots show, for the trend's windows: null where no observation is close enough. */
export function growthWindows(snapshots: readonly Snapshot[], stars: number, now: Date): { stars24h: number | null; stars7d: number | null } {
  const at24h = starsAtStart(snapshots, DAY_MS, WINDOW_TOLERANCE_MS, now);
  const at7d = starsAtStart(snapshots, 7 * DAY_MS, 2 * DAY_MS, now);
  return {
    stars24h: at24h === null ? null : Math.max(0, stars - at24h),
    stars7d: at7d === null ? null : Math.max(0, stars - at7d),
  };
}
