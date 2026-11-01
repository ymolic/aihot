-- spark-github: one row per observed repository per collection run, the history the repository's
-- trend score (raw.sparkGithub.trendScore) reads its growth windows from. The observation itself is
-- the key: one snapshot per repository per instant.
CREATE TABLE spark_github_snapshots (
  repo         text NOT NULL,
  stars        integer NOT NULL,
  forks        integer NOT NULL,
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (repo, observed_at)
);
