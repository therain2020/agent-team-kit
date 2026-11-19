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
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  checkpoint_id TEXT,
  error TEXT,
  version INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS artifact_edges (
  edge_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_kind TEXT NOT NULL DEFAULT 'artifact',
  from_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_kind TEXT NOT NULL DEFAULT 'artifact',
  to_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (from_kind, from_id, from_version, to_kind, to_id, to_version, relation)
);

CREATE INDEX IF NOT EXISTS idx_artifact_edges_from ON artifact_edges(from_id, from_version, relation);
CREATE INDEX IF NOT EXISTS idx_artifact_edges_to ON artifact_edges(to_id, to_version, relation);

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
  kind TEXT NOT NULL DEFAULT 'pack_run',
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_version INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE run_requests
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'pack_run';

ALTER TABLE run_requests
  ADD COLUMN IF NOT EXISTS lease_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stages ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE autopilot_state
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE iteration_runs ADD COLUMN IF NOT EXISTS repo_root TEXT;

CREATE TABLE IF NOT EXISTS kill_switches (
  switch_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  released_by TEXT,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kill_switches_identity
  ON kill_switches(scope, target, workspace_id);
CREATE INDEX IF NOT EXISTS idx_kill_switches_state
  ON kill_switches(state, scope, updated_at DESC);

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
  signal_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  signal_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  eval_snapshot_path TEXT,
  eval_snapshot_hash TEXT,
  evaluator_hash TEXT,
  evaluator_approval_ref TEXT,
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
  canary_eval_snapshot_path TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, pack_dir)
);

CREATE TABLE IF NOT EXISTS evolution_decisions (
  decision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_traffic_percent INTEGER NOT NULL DEFAULT 0,
  to_traffic_percent INTEGER NOT NULL DEFAULT 0,
  trigger_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_meta (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS eval_snapshot_path TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS eval_snapshot_hash TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS evaluator_hash TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS evaluator_approval_ref TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS signal_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS signal_sources JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evolution_state
  ADD COLUMN IF NOT EXISTS canary_eval_snapshot_path TEXT;

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

CREATE TABLE IF NOT EXISTS op_log (
  seq BIGSERIAL PRIMARY KEY,
  op_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  actor TEXT NOT NULL,
  origin TEXT NOT NULL,
  idempotency_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_op_log_idempotency
  ON op_log(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_op_log_workspace_seq
  ON op_log(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_op_log_entity
  ON op_log(entity_kind, entity_id, seq);

CREATE TABLE IF NOT EXISTS run_projection (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending',
  current_stage TEXT,
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_cny NUMERIC NOT NULL DEFAULT 0,
  tokens BIGINT NOT NULL DEFAULT 0,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  wait_reason TEXT,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_projection_status
  ON run_projection(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_run_projection_updated
  ON run_projection(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS degradation_state (
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
  behavior TEXT NOT NULL,
  quality_floor JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  entered_by TEXT NOT NULL,
  exited_at TIMESTAMPTZ,
  exit_reason TEXT,
  PRIMARY KEY (scope, workspace_id)
);

CREATE TABLE IF NOT EXISTS degradation_audit (
  audit_id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_degradation_audit_occurred ON degradation_audit(occurred_at DESC);

CREATE TABLE IF NOT EXISTS ops_settings (
  workspace_id TEXT PRIMARY KEY,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_alerts (
  alert_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  stage_id TEXT,
  request_id TEXT,
  source TEXT,
  runbook_url TEXT,
  notify_state TEXT NOT NULL DEFAULT 'none',
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_autonomy_presets (
  preset_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_by TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  rolled_back_by TEXT,
  rolled_back_at TIMESTAMPTZ,
  rollback_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_autonomy_active
  ON ops_autonomy_presets(workspace_id, status);

CREATE TABLE IF NOT EXISTS manager_sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ends_at TIMESTAMPTZ NOT NULL,
  first_at TIMESTAMPTZ NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny NUMERIC NOT NULL DEFAULT 0,
  exchanges INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  last_rejection_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS budgets (
  budget_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_key TEXT NOT NULL,
  period TEXT,
  day_key TEXT,
  month_key TEXT,
  limit_cny_micro BIGINT,
  limit_tokens BIGINT,
  spent_cny_micro BIGINT NOT NULL DEFAULT 0,
  spent_tokens BIGINT NOT NULL DEFAULT 0,
  reserved_cny_micro BIGINT NOT NULL DEFAULT 0,
  reserved_tokens BIGINT NOT NULL DEFAULT 0,
  hard BOOLEAN NOT NULL DEFAULT true,
  alert80_cny BOOLEAN NOT NULL DEFAULT false,
  alert80_tokens BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, scope, target_key)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  budget_ids JSONB NOT NULL,
  amount_cny_micro BIGINT NOT NULL,
  amount_tokens BIGINT NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_charges (
  charge_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  cost_cny_micro BIGINT NOT NULL DEFAULT 0,
  tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reservation_id)
);

CREATE INDEX IF NOT EXISTS idx_budgets_workspace ON budgets(workspace_id, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_status ON budget_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_budget_charges_run ON budget_charges(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_charges_run_timeline
  ON budget_charges(workspace_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_manifests_run ON manifests(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_requests_status ON run_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_scores_variant ON evolution_scores(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_variants_pack ON evolution_variants(pack_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_cycles_created ON evolution_cycles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_decisions_created ON evolution_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_tickets_status ON merge_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_runs_updated ON iteration_runs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_run ON iteration_tasks(iteration_id, task_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_run ON iteration_events(iteration_id, event_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_turn ON iteration_events(iteration_id, task_id, turn, step);
CREATE INDEX IF NOT EXISTS idx_iteration_turns_run ON iteration_turns(iteration_id, task_id, turn);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity_events(run_id, event_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_workspace ON ops_alerts(workspace_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_dedupe ON ops_alerts(workspace_id, dedupe_key, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requester TEXT NOT NULL,
  required_role TEXT,
  payload_ref TEXT,
  sla_due_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  decision_by TEXT,
  decision_at TIMESTAMPTZ,
  decision_reason TEXT,
  assignee TEXT,
  assigned_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_inbox
  ON approvals(workspace_id, status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run
  ON approvals(run_id, created_at DESC);

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
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
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  checkpoint_id TEXT,
  error TEXT,
  version INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS artifact_edges (
  edge_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_kind TEXT NOT NULL DEFAULT 'artifact',
  from_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_kind TEXT NOT NULL DEFAULT 'artifact',
  to_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_kind, from_id, from_version, to_kind, to_id, to_version, relation)
);

CREATE INDEX IF NOT EXISTS idx_artifact_edges_from ON artifact_edges(from_id, from_version, relation);
CREATE INDEX IF NOT EXISTS idx_artifact_edges_to ON artifact_edges(to_id, to_version, relation);

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
  kind TEXT NOT NULL DEFAULT 'pack_run',
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kill_switches (
  switch_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  released_by TEXT,
  released_at TEXT,
  release_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kill_switches_identity
  ON kill_switches(scope, target, workspace_id);
CREATE INDEX IF NOT EXISTS idx_kill_switches_state
  ON kill_switches(state, scope, updated_at DESC);

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
  signal_refs TEXT NOT NULL DEFAULT '[]',
  signal_sources TEXT NOT NULL DEFAULT '[]',
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
  eval_snapshot_path TEXT,
  eval_snapshot_hash TEXT,
  evaluator_hash TEXT,
  evaluator_approval_ref TEXT,
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
  canary_eval_snapshot_path TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, pack_dir)
);

CREATE TABLE IF NOT EXISTS evolution_decisions (
  decision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_traffic_percent INTEGER NOT NULL DEFAULT 0,
  to_traffic_percent INTEGER NOT NULL DEFAULT 0,
  trigger_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS op_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  actor TEXT NOT NULL,
  origin TEXT NOT NULL,
  idempotency_key TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- SQLite has supported partial indexes since 3.8.0, so the same
-- "unique only when a key is present" rule as Postgres works unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS uq_op_log_idempotency
  ON op_log(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_op_log_workspace_seq
  ON op_log(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_op_log_entity
  ON op_log(entity_kind, entity_id, seq);

CREATE TABLE IF NOT EXISTS run_projection (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending',
  current_stage TEXT,
  progress REAL NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  wait_reason TEXT,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_projection_status
  ON run_projection(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_run_projection_updated
  ON run_projection(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS degradation_state (
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  behavior TEXT NOT NULL,
  quality_floor TEXT NOT NULL DEFAULT '{}',
  exit_criteria TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  exited_at TEXT,
  exit_reason TEXT,
  PRIMARY KEY (scope, workspace_id)
);

CREATE TABLE IF NOT EXISTS degradation_audit (
  audit_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_degradation_audit_occurred ON degradation_audit(occurred_at DESC);

CREATE TABLE IF NOT EXISTS ops_settings (
  workspace_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_alerts (
  alert_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  stage_id TEXT,
  request_id TEXT,
  source TEXT,
  runbook_url TEXT,
  notify_state TEXT NOT NULL DEFAULT 'none',
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_autonomy_presets (
  preset_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  rolled_back_by TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_autonomy_active
  ON ops_autonomy_presets(workspace_id, status);

CREATE TABLE IF NOT EXISTS manager_sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  exchanges INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  last_rejection_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

ALTER TABLE autopilot_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE run_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'pack_run';

ALTER TABLE run_requests ADD COLUMN lease_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stages ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE iteration_runs ADD COLUMN repo_root TEXT;

ALTER TABLE evolution_cycles ADD COLUMN eval_snapshot_path TEXT;
ALTER TABLE evolution_cycles ADD COLUMN eval_snapshot_hash TEXT;
ALTER TABLE evolution_cycles ADD COLUMN evaluator_hash TEXT;
ALTER TABLE evolution_cycles ADD COLUMN evaluator_approval_ref TEXT;
ALTER TABLE evolution_cycles ADD COLUMN signal_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evolution_cycles ADD COLUMN signal_sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evolution_state ADD COLUMN canary_eval_snapshot_path TEXT;

CREATE TABLE IF NOT EXISTS budgets (
  budget_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_key TEXT NOT NULL,
  period TEXT,
  day_key TEXT,
  month_key TEXT,
  limit_cny_micro INTEGER,
  limit_tokens INTEGER,
  spent_cny_micro INTEGER NOT NULL DEFAULT 0,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_cny_micro INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  hard INTEGER NOT NULL DEFAULT 1,
  alert80_cny INTEGER NOT NULL DEFAULT 0,
  alert80_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, scope, target_key)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  budget_ids TEXT NOT NULL,
  amount_cny_micro INTEGER NOT NULL,
  amount_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_charges (
  charge_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  cost_cny_micro INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (reservation_id)
);

CREATE INDEX IF NOT EXISTS idx_budgets_workspace ON budgets(workspace_id, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_status ON budget_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_budget_charges_run ON budget_charges(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_charges_run_timeline
  ON budget_charges(workspace_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_manifests_run ON manifests(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_requests_status ON run_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_scores_variant ON evolution_scores(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_variants_pack ON evolution_variants(pack_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_cycles_created ON evolution_cycles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_decisions_created ON evolution_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_tickets_status ON merge_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_runs_updated ON iteration_runs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_run ON iteration_tasks(iteration_id, task_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_run ON iteration_events(iteration_id, event_id);
CREATE INDEX IF NOT EXISTS idx_iteration_events_turn ON iteration_events(iteration_id, task_id, turn, step);
CREATE INDEX IF NOT EXISTS idx_iteration_turns_run ON iteration_turns(iteration_id, task_id, turn);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity_events(run_id, event_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_workspace ON ops_alerts(workspace_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_dedupe ON ops_alerts(workspace_id, dedupe_key, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requester TEXT NOT NULL,
  required_role TEXT,
  payload_ref TEXT,
  sla_due_at TEXT,
  expires_at TEXT,
  decision_by TEXT,
  decision_at TEXT,
  decision_reason TEXT,
  assignee TEXT,
  assigned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_inbox
  ON approvals(workspace_id, status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run
  ON approvals(run_id, created_at DESC);

ALTER TABLE approvals ADD COLUMN assignee TEXT;
ALTER TABLE approvals ADD COLUMN assigned_at TEXT;
`;
