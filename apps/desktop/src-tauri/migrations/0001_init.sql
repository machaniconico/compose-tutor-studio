CREATE TABLE project_generations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('save', 'delete')),
  operation_id TEXT NOT NULL,
  head_version TEXT NOT NULL,
  parent_head_version TEXT,
  activation_id TEXT,
  revision INTEGER,
  predecessor_write_id TEXT,
  saved_at TEXT NOT NULL,
  payload_json BLOB,
  payload_crc32 TEXT,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  title TEXT,
  updated_at TEXT,
  record_crc32 TEXT NOT NULL,
  branch_source TEXT CHECK (
    branch_source IS NULL
    OR (kind = 'save' AND branch_source IN (
      'recovery-journal',
      'interrupted-save',
      'legacy-migration'
    ))
  ),
  UNIQUE (project_id, head_version),
  UNIQUE (project_id, kind, operation_id),
  CHECK (
    (
      kind = 'save'
      AND activation_id IS NOT NULL
      AND revision IS NOT NULL
      AND revision >= 0
      AND payload_json IS NOT NULL
      AND payload_crc32 IS NOT NULL
      AND payload_bytes > 0
      AND title IS NOT NULL
      AND updated_at IS NOT NULL
    )
    OR
    (
      kind = 'delete'
      AND activation_id IS NULL
      AND revision IS NULL
      AND predecessor_write_id IS NULL
      AND payload_json IS NULL
      AND payload_crc32 IS NULL
      AND payload_bytes = 0
      AND title IS NULL
      AND updated_at IS NULL
    )
  )
) STRICT;

CREATE INDEX project_generations_project_seq
  ON project_generations (project_id, seq DESC);

CREATE TABLE project_heads (
  project_id TEXT PRIMARY KEY,
  generation_seq INTEGER NOT NULL,
  head_version TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  head_crc32 TEXT NOT NULL,
  FOREIGN KEY (generation_seq) REFERENCES project_generations (seq)
) STRICT;

CREATE INDEX project_heads_generation
  ON project_heads (generation_seq);

CREATE TABLE legacy_migration_snapshots (
  content_checksum TEXT PRIMARY KEY,
  storage_version INTEGER NOT NULL CHECK (storage_version = 1),
  created_at TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  envelope_checksum TEXT NOT NULL,
  backup_crc32 TEXT NOT NULL,
  backed_up_at TEXT NOT NULL
) STRICT;

CREATE TABLE legacy_migration_records (
  content_checksum TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  storage_key BLOB NOT NULL,
  storage_value BLOB NOT NULL,
  value_bytes INTEGER NOT NULL CHECK (value_bytes >= 0),
  source_checksum TEXT NOT NULL,
  record_crc32 TEXT NOT NULL,
  PRIMARY KEY (content_checksum, ordinal),
  UNIQUE (content_checksum, storage_key),
  FOREIGN KEY (content_checksum)
    REFERENCES legacy_migration_snapshots (content_checksum) ON DELETE CASCADE
) STRICT;

CREATE TABLE legacy_migration_runs (
  content_checksum TEXT NOT NULL,
  migration_version INTEGER NOT NULL CHECK (migration_version >= 1),
  completed_at TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  ready_project_count INTEGER NOT NULL CHECK (ready_project_count >= 0),
  unreadable_project_count INTEGER NOT NULL CHECK (unreadable_project_count >= 0),
  branch_count INTEGER NOT NULL CHECK (branch_count >= 0),
  PRIMARY KEY (content_checksum, migration_version),
  FOREIGN KEY (content_checksum)
    REFERENCES legacy_migration_snapshots (content_checksum) ON DELETE CASCADE
) STRICT;

CREATE TABLE legacy_project_staging (
  content_checksum TEXT NOT NULL,
  migration_version INTEGER NOT NULL CHECK (migration_version >= 1),
  project_id TEXT NOT NULL,
  source_keys_json BLOB NOT NULL,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('head', 'branch', 'diagnostic')),
  candidate_operation_id TEXT NOT NULL,
  payload_crc32 TEXT,
  payload_bytes INTEGER CHECK (payload_bytes > 0),
  payload_json BLOB,
  title TEXT,
  updated_at TEXT,
  source TEXT,
  activation_id TEXT,
  revision INTEGER,
  write_id TEXT,
  saved_at TEXT,
  diagnostic_error_code TEXT CHECK (
    diagnostic_error_code IS NULL
    OR diagnostic_error_code IN (
      'corrupt-data',
      'unsupported-version',
      'migration-failed',
      'conflict'
    )
  ),
  staged_at TEXT NOT NULL,
  PRIMARY KEY (
    content_checksum,
    migration_version,
    project_id,
    candidate_kind,
    candidate_operation_id
  ),
  FOREIGN KEY (content_checksum)
    REFERENCES legacy_migration_snapshots (content_checksum) ON DELETE CASCADE,
  CHECK (
    (
      candidate_kind = 'head'
      AND candidate_operation_id = 'legacy-head'
      AND payload_crc32 IS NOT NULL
      AND payload_bytes IS NOT NULL
      AND payload_json IS NOT NULL
      AND title IS NOT NULL
      AND updated_at IS NOT NULL
      AND source IS NULL
      AND activation_id IS NULL
      AND revision IS NULL
      AND write_id IS NULL
      AND saved_at IS NULL
      AND diagnostic_error_code IS NULL
    )
    OR
    (
      candidate_kind = 'branch'
      AND payload_crc32 IS NOT NULL
      AND payload_bytes IS NOT NULL
      AND payload_json IS NOT NULL
      AND title IS NOT NULL
      AND updated_at IS NOT NULL
      AND source IN ('recovery-journal', 'interrupted-save')
      AND activation_id IS NOT NULL
      AND revision IS NOT NULL
      AND revision >= 0
      AND write_id IS NOT NULL
      AND candidate_operation_id = write_id
      AND saved_at IS NOT NULL
      AND diagnostic_error_code IS NULL
    )
    OR
    (
      candidate_kind = 'diagnostic'
      AND candidate_operation_id = 'diagnostic'
      AND payload_crc32 IS NULL
      AND payload_bytes IS NULL
      AND payload_json IS NULL
      AND title IS NULL
      AND updated_at IS NULL
      AND source IS NULL
      AND activation_id IS NULL
      AND revision IS NULL
      AND write_id IS NULL
      AND saved_at IS NULL
      AND diagnostic_error_code IS NOT NULL
    )
  )
) STRICT;
