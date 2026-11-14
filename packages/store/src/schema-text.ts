export const PG_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS run_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE autopilot_state
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE iteration_runs ADD COLUMN IF NOT EXISTS repo_root TEXT;

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
  repo_root TEXT,
  goal TEXT NOT NULL,
  acceptance TEXT,
  run_mode TEXT NOT NULL,
  apply_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  plan_artifact_id TEXT,
  report_artifact_id TEXT,
  error TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  last_event_id BIGINT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
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
  last_heartbeat_at TIMESTAMPTZ,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (iteration_id, task_id)
);

CREATE TABLE IF NOT EXISTS iteration_events (
  event_id BIGSERIAL PRIMARY KEY,
  iteration_id TEXT NOT NULL REFERENCES iteration_runs(iteration_id) ON DELETE CASCADE,
  task_id TEXT,
  turn INTEGER,
  step INTEGER,
  kind TEXT NOT NULL,
  status TEXT,
  tool TEXT,
  summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS iteration_turns (
  iteration_id TEXT NOT NULL REFERENCES iteration_runs(iteration_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (iteration_id, task_id, turn)
);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  status TEXT,
  tool TEXT,
  summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_requests_status ON run_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_scores_variant ON evolution_scores(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_variants_pack ON evolution_variants(pack_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_cycles_created ON evolution_cycles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_tickets_status ON merge_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_runs_updated ON iteration_runs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_run ON iteration_tasks(iteration_id, task_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_run ON iteration_events(iteration_id, event_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_turn ON iteration_events(iteration_id, task_id, turn, step);
CREATE INDEX IF NOT EXISTS idx_iteration_turns_run ON iteration_turns(iteration_id, task_id, turn);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity_events(run_id, event_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind, created_at DESC);
`;

export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  payload_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  checkpoint_id TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS manifests (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  input_refs TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  cost TEXT NOT NULL,
  eval_refs TEXT NOT NULL DEFAULT '[]',
  approval_refs TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, sha256)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS autopilot_state (
  workspace_id TEXT NOT NULL,
  pack_dir TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT,
  next_runs TEXT NOT NULL DEFAULT '{}',
  day TEXT,
  runs_today INTEGER NOT NULL DEFAULT 0,
  spent_today REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, pack_dir)
);

CREATE TABLE IF NOT EXISTS run_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_variants (
  variant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  agent_id TEXT NOT NULL,
  pack_dir TEXT NOT NULL DEFAULT '',
  dir_path TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_variant_files (
  variant_id TEXT NOT NULL REFERENCES evolution_variants(variant_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (variant_id, path)
);

CREATE TABLE IF NOT EXISTS evolution_scores (
  score_id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  pass INTEGER NOT NULL,
  scores TEXT NOT NULL,
  rationale TEXT NOT NULL,
  cost_cny REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  draft_chars INTEGER NOT NULL DEFAULT 0,
  stub INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_cycles (
  cycle_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  pack_dir TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  signals TEXT NOT NULL DEFAULT '[]',
  baseline_variant_id TEXT,
  candidate_variant_id TEXT,
  baseline_name TEXT NOT NULL DEFAULT '',
  candidate_name TEXT NOT NULL DEFAULT '',
  baseline_pass INTEGER,
  candidate_pass INTEGER,
  baseline_score REAL,
  candidate_score REAL,
  cost_cny REAL NOT NULL DEFAULT 0,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  auto_applied INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_state (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  pack_dir TEXT NOT NULL DEFAULT '',
  champion_variant_id TEXT NOT NULL,
  canary_variant_id TEXT,
  canary_status TEXT,
  canary_percent INTEGER,
  canary_since TEXT,
  canary_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, pack_dir)
);

CREATE TABLE IF NOT EXISTS evolution_meta (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS merge_tickets (
  ticket_id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  patch_artifact_id TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  head_before TEXT,
  commit_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS iteration_runs (
  iteration_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  repo_root TEXT,
  goal TEXT NOT NULL,
  acceptance TEXT,
  run_mode TEXT NOT NULL,
  apply_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  plan_artifact_id TEXT,
  report_artifact_id TEXT,
  error TEXT,
  last_heartbeat_at TEXT,
  last_event_id INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
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
  changed_files TEXT NOT NULL DEFAULT '[]',
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
  last_heartbeat_at TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (iteration_id, task_id)
);

CREATE TABLE IF NOT EXISTS iteration_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT NOT NULL REFERENCES iteration_runs(iteration_id) ON DELETE CASCADE,
  task_id TEXT,
  turn INTEGER,
  step INTEGER,
  kind TEXT NOT NULL,
  status TEXT,
  tool TEXT,
  summary TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS iteration_turns (
  iteration_id TEXT NOT NULL REFERENCES iteration_runs(iteration_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (iteration_id, task_id, turn)
);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  status TEXT,
  tool TEXT,
  summary TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

ALTER TABLE autopilot_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE iteration_runs ADD COLUMN repo_root TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_requests_status ON run_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_scores_variant ON evolution_scores(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_variants_pack ON evolution_variants(pack_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_cycles_created ON evolution_cycles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_tickets_status ON merge_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_runs_updated ON iteration_runs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_run ON iteration_tasks(iteration_id, task_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_run ON iteration_events(iteration_id, event_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_turn ON iteration_events(iteration_id, task_id, turn, step);
CREATE INDEX IF NOT EXISTS idx_iteration_turns_run ON iteration_turns(iteration_id, task_id, turn);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity_events(run_id, event_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind, created_at DESC);
`;
