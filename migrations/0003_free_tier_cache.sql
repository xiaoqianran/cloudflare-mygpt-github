ALTER TABLE repositories ADD COLUMN last_accessed_at TEXT;

UPDATE repositories
SET last_accessed_at = COALESCE(synced_at, sync_started_at, CURRENT_TIMESTAMP)
WHERE last_accessed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_repositories_last_accessed
  ON repositories (last_accessed_at);

UPDATE repo_fts
SET content = substr(content, 1, 20000)
WHERE length(content) > 20000;
