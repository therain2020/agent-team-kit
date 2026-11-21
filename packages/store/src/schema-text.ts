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
  origin_kind TEXT,
  trigger_id TEXT,
  trigger_run_id TEXT,
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

CREATE TABLE IF NOT EXISTS trigger_runs (
  trigger_run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  route_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  launched_at TIMESTAMPTZ NOT NULL,
  estimate_cny NUMERIC NOT NULL DEFAULT 0,
  payload_ref TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (trigger_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_trigger_runs_trigger
  ON trigger_runs(workspace_id, trigger_id, launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_runs_job
  ON trigger_runs(workspace_id, job_id);

-- One TriggerRun per job: a job is launched by exactly one firing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_runs_job_id
  ON trigger_runs(job_id);

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

ALTER TABLE runs ADD COLUMN IF NOT EXISTS origin_kind TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_run_id TEXT;
ALTER TABLE iteration_runs ADD COLUMN IF NOT EXISTS origin_kind TEXT;
ALTER TABLE iteration_runs ADD COLUMN IF NOT EXISTS trigger_id TEXT;
ALTER TABLE iteration_runs ADD COLUMN IF NOT EXISTS trigger_run_id TEXT;

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
  budget_status TEXT NOT NULL DEFAULT 'unledgered',
  budget_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_reconciliation JSONB,
  eval_snapshot_path TEXT,
  eval_snapshot_hash TEXT,
  evaluator_hash TEXT,
  evaluator_approval_ref TEXT,
  outcome_score DOUBLE PRECISION,
  outcome_pass BOOLEAN,
  outcome_source TEXT,
  outcome_ref TEXT,
  divergence JSONB,
  drift JSONB,
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

CREATE TABLE IF NOT EXISTS evolution_freeze (
  workspace_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT,
  reason TEXT,
  actor TEXT,
  since TIMESTAMPTZ,
  lift_condition TEXT,
  lifted_at TIMESTAMPTZ,
  lifted_by TEXT,
  lift_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL
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
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS budget_status TEXT NOT NULL DEFAULT 'unledgered';
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS budget_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS budget_reconciliation JSONB;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS outcome_score DOUBLE PRECISION;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS outcome_pass BOOLEAN;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS outcome_source TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS outcome_ref TEXT;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS divergence JSONB;
ALTER TABLE evolution_cycles
  ADD COLUMN IF NOT EXISTS drift JSONB;
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
  origin_kind TEXT,
  trigger_id TEXT,
  trigger_run_id TEXT,
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

CREATE TABLE IF NOT EXISTS last_known_good (
  lkg_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  artifact_refs JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  verifier TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lkg_active
  ON last_known_good(workspace_id, target_key, status);
CREATE INDEX IF NOT EXISTS idx_lkg_verified
  ON last_known_good(verified_at DESC);

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

CREATE TABLE IF NOT EXISTS circuit_breakers (
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  sample_window JSONB NOT NULL DEFAULT '[]'::jsonb,
  opened_at TIMESTAMPTZ,
  half_open_started_at TIMESTAMPTZ,
  half_open_successes INTEGER NOT NULL DEFAULT 0,
  last_trip_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  trip_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_circuit_breakers_state
  ON circuit_breakers(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_circuit_breakers_workspace
  ON circuit_breakers(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  workspace_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_occurred
  ON circuit_breaker_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS event_spool (
  spool_id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2',
  payload TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  enqueued_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_spool_pending
  ON event_spool(delivered_at, spool_id);

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
CREATE INDEX IF NOT EXISTS idx_runs_origin ON runs(workspace_id, origin_kind, created_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_iteration_runs_origin ON iteration_runs(workspace_id, origin_kind, updated_at DESC);
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
  substrate TEXT,
  change_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_inbox
  ON approvals(workspace_id, status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run
  ON approvals(run_id, created_at DESC);

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS substrate TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS change_id TEXT;
CREATE INDEX IF NOT EXISTS idx_approvals_change
  ON approvals(change_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cost_records (
  record_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'run',
  scope_id TEXT,
  job_id TEXT,
  change_id TEXT,
  manager_session_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  source TEXT NOT NULL,
  artifact_id TEXT,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  unit_price_in_micro BIGINT NOT NULL DEFAULT 0,
  unit_price_out_micro BIGINT NOT NULL DEFAULT 0,
  price_version TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  cost_cny_micro BIGINT NOT NULL DEFAULT 0,
  tracked BOOLEAN NOT NULL DEFAULT true,
  untracked_reason TEXT,
  day_key TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_cost_records_day
  ON cost_records(workspace_id, day_key);
CREATE INDEX IF NOT EXISTS idx_cost_records_run
  ON cost_records(workspace_id, run_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cost_records_artifact
  ON cost_records(workspace_id, artifact_id);
ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS scope_kind TEXT NOT NULL DEFAULT 'run';
ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS scope_id TEXT;
ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS job_id TEXT;
ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS change_id TEXT;
ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS manager_session_id TEXT;
UPDATE cost_records SET scope_id = run_id WHERE scope_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_cost_records_scope
  ON cost_records(workspace_id, scope_kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cost_records_job
  ON cost_records(workspace_id, job_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_change
  ON cost_records(workspace_id, change_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_manager_session
  ON cost_records(workspace_id, manager_session_id);

CREATE TABLE IF NOT EXISTS price_tables (
  version TEXT PRIMARY KEY,
  effective_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  entries JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_bills (
  bill_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  amount_cny_micro BIGINT NOT NULL,
  source TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, provider, period_start, period_end, source)
);
CREATE INDEX IF NOT EXISTS idx_provider_bills_period
  ON provider_bills(workspace_id, provider, period_start, period_end);
CREATE TABLE IF NOT EXISTS information_raw_captures (
  capture_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_information_captures_source
  ON information_raw_captures(workspace_id, source_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS information_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'passive',
  capture_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_information_events_source
  ON information_events(workspace_id, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_information_events_created
  ON information_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  items_collected INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  latency_ms_total BIGINT NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  total_cost_cny_micro BIGINT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  degraded BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);

CREATE TABLE IF NOT EXISTS interest_profiles (
  profile_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  daily_budget_cny_micro BIGINT NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  rationale TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, version)
);
CREATE INDEX IF NOT EXISTS idx_interest_profiles_version
  ON interest_profiles(workspace_id, version DESC);

CREATE TABLE IF NOT EXISTS interest_profile_audits (
  audit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT NOT NULL,
  before JSONB,
  after JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_profile_audits_ws
  ON interest_profile_audits(workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS information_signal_audits (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  profile_version INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT 'heuristic',
  relevance DOUBLE PRECISION NOT NULL,
  novelty DOUBLE PRECISION NOT NULL,
  urgency DOUBLE PRECISION NOT NULL,
  risk DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  passes BOOLEAN NOT NULL DEFAULT false,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_information_signal_audits_ws
  ON information_signal_audits(workspace_id, scored_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  postmortem JSONB NOT NULL,
  degradation_mode_id TEXT,
  regression_case_ref TEXT,
  evolution_signal_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_incidents_workspace
  ON incidents(workspace_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status
  ON incidents(workspace_id, status);

CREATE TABLE IF NOT EXISTS runbooks (
  runbook_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  steps JSONB NOT NULL,
  owner TEXT NOT NULL,
  verification JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_runbooks_mode
  ON runbooks(workspace_id, mode_id);

CREATE TABLE IF NOT EXISTS runbook_drills (
  drill_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  runbook_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  executed_by TEXT NOT NULL,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runbook_drills_runbook
  ON runbook_drills(runbook_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runbook_drills_workspace
  ON runbook_drills(workspace_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS recovery_drills (
  drill_id TEXT PRIMARY KEY,
  executed_at TIMESTAMPTZ NOT NULL,
  executed_by TEXT NOT NULL,
  script TEXT NOT NULL,
  rto_target_minutes INTEGER NOT NULL,
  rpo_target_minutes INTEGER NOT NULL,
  measured_rto_minutes INTEGER,
  measured_rpo_minutes INTEGER,
  kitd_rollback_ref TEXT,
  integrity_pass BOOLEAN NOT NULL DEFAULT false,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_drills_executed
  ON recovery_drills(executed_at DESC);

CREATE TABLE IF NOT EXISTS change_proposals (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  substrate TEXT NOT NULL,
  producer TEXT NOT NULL,
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  acceptance JSONB NOT NULL DEFAULT '[]'::jsonb,
  signal_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  eval_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_ref JSONB,
  revert_ref TEXT,
  revert JSONB,
  budget_ref TEXT,
  approval_ref TEXT,
  outcome JSONB,
  content_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE change_proposals ADD COLUMN IF NOT EXISTS revert JSONB;

CREATE INDEX IF NOT EXISTS idx_change_proposals_workspace
  ON change_proposals(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_proposals_state
  ON change_proposals(workspace_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_proposals_producer
  ON change_proposals(workspace_id, producer, created_at DESC);

CREATE TABLE IF NOT EXISTS change_proposal_transitions (
  audit_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES change_proposals(proposal_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL,
  sequence INTEGER NOT NULL,
  UNIQUE (proposal_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_change_transitions_proposal
  ON change_proposal_transitions(proposal_id, sequence);
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
  origin_kind TEXT,
  trigger_id TEXT,
  trigger_run_id TEXT,
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

CREATE TABLE IF NOT EXISTS trigger_runs (
  trigger_run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  route_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  launched_at TEXT NOT NULL,
  estimate_cny REAL NOT NULL DEFAULT 0,
  payload_ref TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (trigger_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_trigger_runs_trigger
  ON trigger_runs(workspace_id, trigger_id, launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_runs_job
  ON trigger_runs(workspace_id, job_id);

-- One TriggerRun per job: a job is launched by exactly one firing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_runs_job_id
  ON trigger_runs(job_id);

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
  budget_status TEXT NOT NULL DEFAULT 'unledgered',
  budget_refs TEXT NOT NULL DEFAULT '[]',
  budget_reconciliation TEXT,
  eval_snapshot_path TEXT,
  eval_snapshot_hash TEXT,
  evaluator_hash TEXT,
  evaluator_approval_ref TEXT,
  outcome_score REAL,
  outcome_pass INTEGER,
  outcome_source TEXT,
  outcome_ref TEXT,
  divergence TEXT,
  drift TEXT,
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

CREATE TABLE IF NOT EXISTS evolution_freeze (
  workspace_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT,
  reason TEXT,
  actor TEXT,
  since TEXT,
  lift_condition TEXT,
  lifted_at TEXT,
  lifted_by TEXT,
  lift_reason TEXT,
  updated_at TEXT NOT NULL
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
  origin_kind TEXT,
  trigger_id TEXT,
  trigger_run_id TEXT,
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

CREATE TABLE IF NOT EXISTS last_known_good (
  lkg_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  artifact_refs TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  verifier TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lkg_active
  ON last_known_good(workspace_id, target_key, status);
CREATE INDEX IF NOT EXISTS idx_lkg_verified
  ON last_known_good(verified_at DESC);

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

CREATE TABLE IF NOT EXISTS circuit_breakers (
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  sample_window TEXT NOT NULL DEFAULT '[]',
  opened_at TEXT,
  half_open_started_at TEXT,
  half_open_successes INTEGER NOT NULL DEFAULT 0,
  last_trip_at TEXT,
  recovered_at TEXT,
  trip_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_circuit_breakers_state
  ON circuit_breakers(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_circuit_breakers_workspace
  ON circuit_breakers(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_occurred
  ON circuit_breaker_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS event_spool (
  spool_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2',
  payload TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  enqueued_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_spool_pending
  ON event_spool(delivered_at, spool_id);

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

ALTER TABLE runs ADD COLUMN origin_kind TEXT;
ALTER TABLE runs ADD COLUMN trigger_id TEXT;
ALTER TABLE runs ADD COLUMN trigger_run_id TEXT;
ALTER TABLE iteration_runs ADD COLUMN origin_kind TEXT;
ALTER TABLE iteration_runs ADD COLUMN trigger_id TEXT;
ALTER TABLE iteration_runs ADD COLUMN trigger_run_id TEXT;

ALTER TABLE evolution_cycles ADD COLUMN eval_snapshot_path TEXT;
ALTER TABLE evolution_cycles ADD COLUMN eval_snapshot_hash TEXT;
ALTER TABLE evolution_cycles ADD COLUMN evaluator_hash TEXT;
ALTER TABLE evolution_cycles ADD COLUMN evaluator_approval_ref TEXT;
ALTER TABLE evolution_cycles ADD COLUMN signal_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evolution_cycles ADD COLUMN signal_sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evolution_cycles ADD COLUMN budget_status TEXT NOT NULL DEFAULT 'unledgered';
ALTER TABLE evolution_cycles ADD COLUMN budget_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evolution_cycles ADD COLUMN budget_reconciliation TEXT;
ALTER TABLE evolution_cycles ADD COLUMN outcome_score REAL;
ALTER TABLE evolution_cycles ADD COLUMN outcome_pass INTEGER;
ALTER TABLE evolution_cycles ADD COLUMN outcome_source TEXT;
ALTER TABLE evolution_cycles ADD COLUMN outcome_ref TEXT;
ALTER TABLE evolution_cycles ADD COLUMN divergence TEXT;
ALTER TABLE evolution_cycles ADD COLUMN drift TEXT;
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
CREATE INDEX IF NOT EXISTS idx_runs_origin ON runs(workspace_id, origin_kind, created_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_iteration_runs_origin ON iteration_runs(workspace_id, origin_kind, updated_at DESC);
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
  substrate TEXT,
  change_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_inbox
  ON approvals(workspace_id, status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run
  ON approvals(run_id, created_at DESC);

ALTER TABLE approvals ADD COLUMN assignee TEXT;
ALTER TABLE approvals ADD COLUMN assigned_at TEXT;
ALTER TABLE approvals ADD COLUMN substrate TEXT;
ALTER TABLE approvals ADD COLUMN change_id TEXT;
CREATE INDEX IF NOT EXISTS idx_approvals_change
  ON approvals(change_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cost_records (
  record_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'run',
  scope_id TEXT,
  job_id TEXT,
  change_id TEXT,
  manager_session_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  source TEXT NOT NULL,
  artifact_id TEXT,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  unit_price_in_micro INTEGER NOT NULL DEFAULT 0,
  unit_price_out_micro INTEGER NOT NULL DEFAULT 0,
  price_version TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  cost_cny_micro INTEGER NOT NULL DEFAULT 0,
  tracked INTEGER NOT NULL DEFAULT 1,
  untracked_reason TEXT,
  day_key TEXT NOT NULL,
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_cost_records_day
  ON cost_records(workspace_id, day_key);
CREATE INDEX IF NOT EXISTS idx_cost_records_run
  ON cost_records(workspace_id, run_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cost_records_artifact
  ON cost_records(workspace_id, artifact_id);
ALTER TABLE cost_records ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'run';
ALTER TABLE cost_records ADD COLUMN scope_id TEXT;
ALTER TABLE cost_records ADD COLUMN job_id TEXT;
ALTER TABLE cost_records ADD COLUMN change_id TEXT;
ALTER TABLE cost_records ADD COLUMN manager_session_id TEXT;
UPDATE cost_records SET scope_id = run_id WHERE scope_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_cost_records_scope
  ON cost_records(workspace_id, scope_kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cost_records_job
  ON cost_records(workspace_id, job_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_change
  ON cost_records(workspace_id, change_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_manager_session
  ON cost_records(workspace_id, manager_session_id);

CREATE TABLE IF NOT EXISTS price_tables (
  version TEXT PRIMARY KEY,
  effective_at TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  entries TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_bills (
  bill_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  amount_cny_micro INTEGER NOT NULL,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, period_start, period_end, source)
);
CREATE INDEX IF NOT EXISTS idx_provider_bills_period
  ON provider_bills(workspace_id, provider, period_start, period_end);
CREATE TABLE IF NOT EXISTS information_raw_captures (
  capture_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_information_captures_source
  ON information_raw_captures(workspace_id, source_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS information_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'passive',
  capture_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_information_events_source
  ON information_events(workspace_id, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_information_events_created
  ON information_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  items_collected INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  total_cost_cny_micro INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);

CREATE TABLE IF NOT EXISTS interest_profiles (
  profile_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  exclusions TEXT NOT NULL DEFAULT '[]',
  thresholds TEXT NOT NULL DEFAULT '{}',
  daily_budget_cny_micro INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  rationale TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version)
);
CREATE INDEX IF NOT EXISTS idx_interest_profiles_version
  ON interest_profiles(workspace_id, version DESC);

CREATE TABLE IF NOT EXISTS interest_profile_audits (
  audit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT NOT NULL,
  before TEXT,
  after TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_profile_audits_ws
  ON interest_profile_audits(workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS information_signal_audits (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  profile_version INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT 'heuristic',
  relevance REAL NOT NULL,
  novelty REAL NOT NULL,
  urgency REAL NOT NULL,
  risk REAL NOT NULL,
  confidence REAL NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  reasons TEXT NOT NULL DEFAULT '[]',
  scored_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_information_signal_audits_ws
  ON information_signal_audits(workspace_id, scored_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  timeline TEXT NOT NULL DEFAULT '[]',
  postmortem TEXT NOT NULL,
  degradation_mode_id TEXT,
  regression_case_ref TEXT,
  evolution_signal_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_incidents_workspace
  ON incidents(workspace_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status
  ON incidents(workspace_id, status);

CREATE TABLE IF NOT EXISTS runbooks (
  runbook_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  steps TEXT NOT NULL,
  owner TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_runbooks_mode
  ON runbooks(workspace_id, mode_id);

CREATE TABLE IF NOT EXISTS runbook_drills (
  drill_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  runbook_id TEXT NOT NULL,
  mode_id TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  executed_by TEXT NOT NULL,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runbook_drills_runbook
  ON runbook_drills(runbook_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runbook_drills_workspace
  ON runbook_drills(workspace_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS recovery_drills (
  drill_id TEXT PRIMARY KEY,
  executed_at TEXT NOT NULL,
  executed_by TEXT NOT NULL,
  script TEXT NOT NULL,
  rto_target_minutes INTEGER NOT NULL,
  rpo_target_minutes INTEGER NOT NULL,
  measured_rto_minutes INTEGER,
  measured_rpo_minutes INTEGER,
  kitd_rollback_ref TEXT,
  integrity_pass INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_drills_executed
  ON recovery_drills(executed_at DESC);

CREATE TABLE IF NOT EXISTS change_proposals (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  substrate TEXT NOT NULL,
  producer TEXT NOT NULL,
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '[]',
  signal_refs TEXT NOT NULL DEFAULT '[]',
  eval_plan TEXT NOT NULL DEFAULT '{}',
  source_ref TEXT,
  revert_ref TEXT,
  revert TEXT,
  budget_ref TEXT,
  approval_ref TEXT,
  outcome TEXT,
  content_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE change_proposals ADD COLUMN revert TEXT;

CREATE INDEX IF NOT EXISTS idx_change_proposals_workspace
  ON change_proposals(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_proposals_state
  ON change_proposals(workspace_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_proposals_producer
  ON change_proposals(workspace_id, producer, created_at DESC);

CREATE TABLE IF NOT EXISTS change_proposal_transitions (
  audit_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES change_proposals(proposal_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  UNIQUE (proposal_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_change_transitions_proposal
  ON change_proposal_transitions(proposal_id, sequence);
`;
