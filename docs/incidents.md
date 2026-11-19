# 事故、Runbook 与恢复演练

实现 `61-reliability-degradation.md` §2、§3.4、§5 与 §6（D-38）的事故处理闭环。总账见 issue #11，本切片见 issue #36。

## 实体与契约

`packages/core/src/incident.ts` 是唯一契约来源：

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `Incident` | workspaceId, severity, detectedAt, timeline[], owner, postmortem, status | 事故记录；`owner` 必填（62 责任） |
| `Postmortem` | status(none/draft/final), draftDueAt, finalDueAt, content, author | 与事故同时创建，锁定 24h/48h 截止 |
| `Runbook` | modeId, trigger, steps[], owner, verification[] | 每个降级模式一份；`modeId` 必须是 #61.1 声明的依赖 id |
| `RunbookDrill` | runbookId, modeId, executedAt, executedBy, outcome | 演练记录，覆盖度以「runbook + 记录」双条件计算 |
| `RecoveryDrill` | script, rto/rpoTargetMinutes, measuredRto/RpoMinutes, kitdRollbackRef, integrityPass, outcome | RTO/RPO 演练记录 |

`DEGRADATION_MODE_IDS` 由 `DEFAULT_DEPENDENCIES` 派生，因此 runbook 覆盖范围始终与 #61.1 的降级模式清单同步。

## 复盘节奏（24h / 48h）

- 事故创建即写入 `postmortem.draftDueAt = detectedAt + 24h`、`finalDueAt = detectedAt + 48h`（`postmortemDeadlines`）。
- `postmortemState(incident, now)` 计算 `draftOverdue` / `finalOverdue`：draft 逾期指 24h 内未写初稿，final 逾期指 48h 内未定稿。
- 初稿写入默认置为 `draft`，定稿需显式 `status: "final"`；定稿后不再判逾期。
- 与 62 §3.5 对齐：每次事故有明确 owner，复盘内容进入回归与演化闭环。

## 事故转回归与演化（跨计划对接）

`incidentToRegressionCase(incident)`（计划 40）与 `incidentToEvolutionSignal(incident)`（计划 70）是**文档化的对接点**，返回稳定的 handoff 结构，不建立对未落地计划的硬依赖：

- RegressionCase：`caseId = reg_<incidentId>`，带 `reproduction`（由 timeline 派生）与 `expectedBehavior`（由 postmortem 内容派生），供计划 40 落库。
- 演化信号：`signalId = sig_inc_<incidentId>`，`source: "manual"`（计划 70 的 `SignalSourceKind` 目前无 `incident`，落地时扩枚举即可，字段保持稳定）。
- 事故记录上的 `regressionCaseRef` / `evolutionSignalRef` 字段预留给对接方回填。

## 降级模式覆盖与演练记录

每种降级模式需满足：**存在 active runbook** 且**至少一条演练记录**。

```powershell
# 预览当前覆盖度
bun run runbook:drill
# 为缺失模式写入默认 runbook 模板
bun run runbook:drill --execute --seed-runbooks
# 记录一次演练（pass/fail）
bun run runbook:drill --execute --record --mode model.provider --outcome pass
```

`runbookCoverage(runbooks, drills)` 返回 `coveredModes` / `undrilledModes` / `missingModes`，控制台与 API 直接复用。

## RTO/RPO 恢复演练（D-38）

- 目标：RTO 4h（`RTO_TARGET_MINUTES=240`）、RPO 6h（`RPO_TARGET_MINUTES=360`），每季度演练（`DRILL_INTERVAL_DAYS=90`）。
- **复用既有恢复脚本，不重复实现**：演练包裹 `smoke:recovery`（`apps/runtime/src/temporal/recovery-smoke.ts`），以其退出码与耗时作为恢复校验与 RTO 依据；kitd 回滚作为独立步骤执行后，把审计引用写入 `kitdRollbackRef`。
- RPO 无法由 smoke 脚本测得，通过 `--rpo-minutes` 由 operator 依据数据丢失窗口填写；未填写或超预算则该次演练判为 fail。

```powershell
# 预览
bun run recovery:drill
# 执行 smoke:recovery 并记录一次演练
bun run recovery:drill --execute --rpo-minutes 240 --kitd-rollback-ref "kitd.jsonl#42"
```

`evaluateRecoveryDrill` 的判定：RTO、RPO 均不超预算且 `integrityPass=true` 才为 pass。

## 只读入口

- `GET /api/incidents?workspaceId=<id>`：事故、runbook、覆盖度、最近恢复演练与季度到期状态。
- 控制台 `/incidents`：只读展示覆盖度、复盘到期、事故与 runbook 列表。
- 存储：`incidents`、`runbooks`、`runbook_drills`、`recovery_drills`（`packages/store` 单 schema-text + drizzle 镜像，增量迁移）。

## 验收对照（61 §5）

- 每种降级模式有 runbook 且演练记录 100% 留存：`runbookCoverage` 以「active runbook + drill」双条件度量；`/api/incidents` 与 `/incidents` 如实呈现缺口。
- 恢复校验记录 100%：`RecoveryDrill.integrityPass` + `smoke:recovery` 退出码；失败记录同样留存，不以沉默代替。
- 同类事故 90 天内复发 = 0：事故复盘经 `incidentToRegressionCase` 进入回归集，由计划 40 承接评估。
