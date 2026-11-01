// The trend score's shape: growth in a window drives it when the snapshots reach back that far, the
// repository's own pace when they do not, and no score without the numbers it needs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubTrend, growthWindows, starsAtStart, DAY_MS, WINDOW_TOLERANCE_MS, type Snapshot } from "../backend/trend.ts";

const now = new Date("2026-11-02T00:00:00Z");
const snapshot = (stars: number, daysAgo: number): Snapshot => ({ stars, observedAt: new Date(now.getTime() - daysAgo * DAY_MS) });

test("growth in a window is the stars at the observation nearest its start, within tolerance", () => {
  assert.equal(starsAtStart([snapshot(100, 1)], DAY_MS, WINDOW_TOLERANCE_MS, now), 100);
  // An observation 48 hours old is outside the 24-hour window's tolerance.
  assert.equal(starsAtStart([snapshot(100, 2)], DAY_MS, WINDOW_TOLERANCE_MS, now), null);
  assert.equal(starsAtStart([], DAY_MS, WINDOW_TOLERANCE_MS, now), null);
});

test("growthWindows subtracts the windows' starts from the current stars", () => {
  const history = [snapshot(1000, 1), snapshot(1100, 7), snapshot(1150, 30)];
  assert.deepEqual(growthWindows(history, 1250, now), { stars24h: 250, stars7d: 150 });
});

test("the 24h basis scores growth, its acceleration, quality and recency, capped at 100", () => {
  const flat = githubTrend({ stars: 1000, forks: 100, ageDays: 400, daysSincePush: 1, stars24h: 0, stars7d: 0 });
  const rising = githubTrend({ stars: 1000, forks: 100, ageDays: 400, daysSincePush: 1, stars24h: 40, stars7d: 120 });
  // The day took more than its share of the week: still accelerating.
  const accelerating = githubTrend({ stars: 1000, forks: 100, ageDays: 400, daysSincePush: 1, stars24h: 40, stars7d: 56 });
  assert.ok(flat && rising && accelerating);
  assert.equal(rising.basis, "24h");
  assert.ok(rising.score > flat.score);
  assert.ok(accelerating.score > rising.score);
  assert.ok(rising.score <= 100);
});

test("without a 24h observation the week stands in; without either, the cold start does", () => {
  const week = githubTrend({ stars: 500, forks: 40, ageDays: 200, daysSincePush: 3, stars24h: null, stars7d: 60 });
  assert.equal(week?.basis, "7d");
  const cold = githubTrend({ stars: 500, forks: 40, ageDays: 30, daysSincePush: 1 });
  assert.equal(cold?.basis, "cold-start");
  assert.ok(cold && cold.score > 0);
});

test("a repository without its numbers scores null", () => {
  assert.equal(githubTrend({ stars: NaN, forks: 10, ageDays: 10, daysSincePush: 1 }), null);
  assert.equal(githubTrend({ stars: 10, forks: 10, ageDays: NaN, daysSincePush: 1 }), null);
});
