-- spark-github: the collection spec of each external source the module drives. The sources are
-- kind='external' (the engine skips their listing fetch) and their sources.config whitelist admits
-- publisher keys only, so the collector's parameters live here, one row per source, dropped with it.
CREATE TABLE spark_github_specs (
  source_id   text PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  collector   text NOT NULL CHECK (collector IN ('github_search', 'github_releases', 'hacker_news')),
  spec        jsonb NOT NULL DEFAULT '{}',
  cursor      jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
