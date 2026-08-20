PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  repo TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  head_sha TEXT,
  default_branch TEXT,
  status TEXT NOT NULL DEFAULT 'missing',
  sync_id TEXT,
  pending_batches INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  mirrored_file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  sync_started_at TEXT,
  synced_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS mirror_files (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  is_binary INTEGER,
  is_indexed INTEGER NOT NULL DEFAULT 0,
  sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo, path)
);

CREATE INDEX IF NOT EXISTS idx_mirror_files_repo_path
  ON mirror_files (repo, path);

CREATE INDEX IF NOT EXISTS idx_mirror_files_repo_sync
  ON mirror_files (repo, sync_id);

CREATE INDEX IF NOT EXISTS idx_mirror_files_blob
  ON mirror_files (blob_sha);

CREATE TABLE IF NOT EXISTS mirror_blobs (
  blob_sha TEXT PRIMARY KEY,
  size INTEGER NOT NULL DEFAULT 0,
  is_binary INTEGER,
  is_truncated INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_batches (
  sync_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TEXT,
  PRIMARY KEY (sync_id, batch_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(
  repo UNINDEXED,
  path,
  content,
  tokenize = 'unicode61'
);
