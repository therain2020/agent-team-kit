CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  trace_id TEXT NOT NULL,
  payload_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  checkpoint_id TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS manifests (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  producer JSONB NOT NULL,
  input_refs JSONB NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  cost JSONB NOT NULL,
  eval_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size BIGINT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, sha256)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(blob_id),
  manifest_id TEXT NOT NULL REFERENCES manifests(manifest_id),
  status TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS autopilot_state (
  workspace_id TEXT NOT NULL,
  pack_dir TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_tick_at TIMESTAMPTZ,
  next_runs JSONB NOT NULL DEFAULT '{}'::jsonb,
  day DATE,
  runs_today INTEGER NOT NULL DEFAULT 0,
  spent_today NUMERIC NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, pack_dir)
);

ALTER TABLE autopilot_state
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_variants (
  variant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  agent_id TEXT NOT NULL,
  pack_dir TEXT NOT NULL DEFAULT '',
  dir_path TEXT NOT NULL DEFAULT '',
  meta JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_variant_files (
  variant_id TEXT NOT NULL REFERENCES evolution_variants(variant_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(blob_id),
  sha256 TEXT NOT NULL,
  size BIGINT NOT NULL,
  PRIMARY KEY (variant_id, path)
);

CREATE TABLE IF NOT EXISTS evolution_scores (
  score_id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  pass BOOLEAN NOT NULL,
  scores JSONB NOT NULL,
  rationale TEXT NOT NULL,
  cost_cny NUMERIC NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  draft_chars INTEGER NOT NULL DEFAULT 0,
  stub BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_cycles (
  cycle_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  pack_dir TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  baseline_variant_id TEXT,
  candidate_variant_id TEXT,
  baseline_name TEXT NOT NULL DEFAULT '',
  candidate_name TEXT NOT NULL DEFAULT '',
  baseline_pass BOOLEAN,
  candidate_pass BOOLEAN,
  baseline_score DOUBLE PRECISION,
  candidate_score DOUBLE PRECISION,
  cost_cny NUMERIC NOT NULL DEFAULT 0,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  auto_applied BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_state (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  pack_dir TEXT NOT NULL DEFAULT '',
  champion_variant_id TEXT NOT NULL,
  canary_variant_id TEXT,
  canary_status TEXT,
  canary_percent INTEGER,
  canary_since TIMESTAMPTZ,
  canary_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, pack_dir)
);

CREATE TABLE IF NOT EXISTS evolution_meta (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS merge_tickets (
  ticket_id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  patch_artifact_id TEXT,
  changed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  head_before TEXT,
  commit_sha TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS iteration_runs (
  iteration_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  goal TEXT NOT NULL,
  acceptance TEXT,
  run_mode TEXT NOT NULL,
  apply_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  plan_artifact_id TEXT,
  report_artifact_id TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS iteration_tasks (
  iteration_id TEXT NOT NULL REFERENCES iteration_runs(iteration_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  coder TEXT,
  risk TEXT,
  changed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokens INTEGER NOT NULL DEFAULT 0,
  coder_summary TEXT,
  apply_status TEXT,
  commit_sha TEXT,
  error TEXT,
  diff_artifact_id TEXT,
  transcript_artifact_id TEXT,
  result_artifact_id TEXT,
  verification_artifact_id TEXT,
  apply_artifact_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (iteration_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_evolution_scores_variant ON evolution_scores(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_variants_pack ON evolution_variants(pack_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_cycles_created ON evolution_cycles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_tickets_status ON merge_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_runs_updated ON iteration_runs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_run ON iteration_tasks(iteration_id, task_id);
