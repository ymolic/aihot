// Seeds the module's demonstration sources and their specs, after the migrations:
//   node --env-file-if-exists=.env modules/spark-github/scripts/seed.ts
// Every source is kind='external' (the engine skips the kind's own listing fetch; this module
// collects it) and — deliberately — participation_mode='editorial': the ingest API auto-creates
// external sources as 'isolated', whose material never reaches the editorial scores or the
// selected news, and these sources exist to be curated. All rows start disabled, for operations
// to review and enable. Re-running adds nothing that is already there.
import { closeDb, sql } from "@aihot/backend/db";

interface SeedSource {
  id: string;
  name: string;
  tier: "T1" | "T2";
  spec: Record<string, unknown>;
}

const SEEDS: SeedSource[] = [
  {
    // Official, widely starred repositories: a T1 bar for selection.
    id: "spark-github-search",
    name: "GitHub · AI 项目搜索",
    tier: "T1",
    spec: {
      collector: "github_search",
      queries: [
        "topic:llm stars:>=1000 pushed:>{since}",
        `"AI agent" stars:>=500 pushed:>{since}`,
        "topic:rag stars:>=200 pushed:>{since}",
      ],
      lookbackDays: 14,
      minStars: 200,
    },
  },
  {
    id: "spark-github-releases",
    name: "GitHub · 关注项目发布",
    tier: "T1",
    spec: {
      collector: "github_releases",
      repos: ["ollama/ollama", "vllm-project/vllm"],
    },
  },
  {
    id: "spark-hacker-news",
    name: "Hacker News · AI 首页",
    tier: "T2",
    spec: { collector: "hacker_news", minScore: 30, maxItems: 40 },
  },
];

const inserted = await sql.begin(async tx => {
  let sources = 0;
  let specs = 0;
  for (const seed of SEEDS) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, interval_minutes, enabled)
      VALUES (${seed.id}, ${seed.name}, 'external', '{}', ${["spark-github"]}, ${seed.tier}, 'editorial', 60, false)
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (row) sources += 1;
    const [spec] = await tx<{ source_id: string }[]>`
      INSERT INTO spark_github_specs (source_id, collector, spec)
      VALUES (${seed.id}, ${String(seed.spec.collector)}, ${tx.json(seed.spec as never)})
      ON CONFLICT (source_id) DO NOTHING RETURNING source_id`;
    if (spec) specs += 1;
  }
  return { sources, specs };
});

console.log(`spark-github seed: ${inserted.sources} source(s), ${inserted.specs} spec(s) added; existing rows left as they are. Sources start disabled.`);
await closeDb();
