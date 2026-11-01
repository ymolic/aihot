// Hacker News through Algolia's front page: one request carries every story with its points and
// comment count, where the official Firebase list would cost one request per item. A hit keeps its
// own link when it has one and the discussion otherwise; a story's own text (Ask HN, Show HN) joins
// the material, and a plain link post ships without body text — the engine's extraction then fetches
// the linked page, the same course a listing entry without an excerpt takes.
import { guardedFetch, HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { stripTags, truncate } from "@aihot/backend/lib/text";

const FRONT_PAGE = "https://hn.algolia.com/api/v1/front_page";

/** The module's interest, ported from spark-radar's adapter. */
const AI_TERMS = /\b(ai|agent|llm|model|openai|anthropic|mcp|machine learning|developer tool)\b/i;

export interface HnHit {
  id: string;
  title: string;
  /** The story's link, or the item's own page when it has none. */
  url: string;
  /** The story's own text, as plain text; a link post has none. */
  text: string | null;
  author: string | null;
  points: number;
  comments: number;
  createdAt: Date | null;
}

export async function fetchFrontPage(spec: { minScore: number; maxItems: number }): Promise<HnHit[]> {
  const endpoint = new URL(FRONT_PAGE);
  endpoint.searchParams.set("hitsPerPage", String(spec.maxItems));
  const res = await guardedFetch(endpoint.toString(), { headers: { accept: "application/json" }, maxBytes: 1_000_000, timeoutMs: 15_000 });
  if (res.status !== 200) throw new HttpStatusError(res.status, `Hacker News front page HTTP ${res.status}`);
  const data = JSON.parse(res.text()) as { hits?: unknown };
  if (!Array.isArray(data.hits)) throw new Error("Hacker News front page returned no hit list");
  const hits: HnHit[] = [];
  for (const item of data.hits) {
    const hit = item as Record<string, unknown>;
    const title = typeof hit.title === "string" ? hit.title : null;
    const id = typeof hit.objectID === "string" ? hit.objectID : null;
    if (!title || !id) continue; // comment hits have no title of their own
    const points = Number(hit.points) || 0;
    if (points < spec.minScore) continue;
    const text = typeof hit.story_text === "string" && hit.story_text.trim() ? truncate(stripTags(hit.story_text), 4000) : null;
    if (!AI_TERMS.test(`${title} ${text ?? ""}`)) continue;
    const url = typeof hit.url === "string" && /^https?:/i.test(hit.url) ? hit.url : `https://news.ycombinator.com/item?id=${id}`;
    hits.push({
      id,
      title,
      url,
      text,
      author: typeof hit.author === "string" ? hit.author : null,
      points,
      comments: Number(hit.num_comments) || 0,
      createdAt: typeof hit.created_at === "string" ? new Date(hit.created_at) : null,
    });
  }
  return hits;
}
