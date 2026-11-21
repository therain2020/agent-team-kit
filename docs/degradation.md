# 降级与只读模式

实现 `61-reliability-degradation.md` §2、§3.1、§3.2 与 §5 的降级状态机。总账见 issue #11，本切片见 issue #32。

## 依赖清单

`packages/core/src/degradation.ts` 中的 `DEFAULT_DEPENDENCIES` 是依赖姿态的唯一声明：

| 依赖 | 类型 | 关键性 | 故障姿态 |
|---|---|---|---|
| `model.provider` | provider | critical | fail-open（允许 fallback，否则暂停受影响 stage） |
| `event_bus` | event_bus | critical | fail-open（本地缓冲/重放由 #33 落地） |
| `artifact_store` | artifact_store | critical | fail-closed（停止发布、挂起 run） |
| `source_api` | source_api | degradable | fail-open（暂停摄入、保留队列） |
| `delivery` | delivery | critical | fail-closed（质量底线不达标即阻断交付） |

Stage 可在 `team.yaml` 的 workflow stage 上声明 `failureMode: fail_open | fail_closed`；未声明默认 `fail_open`。`packages/pack` 会把该字段透传到 `PackStageExecutionInput`，由执行守卫在降级期间拦截 `fail_closed` stage。

## 模式

- **degraded**：允许继续执行，但对外交付必须通过声明的质量底线（`minChars` 与禁用片段）。
- **read_only**：暂停新执行与 stage 执行；玻璃盒查看与审计保持可用。
- **范围**：`workspace` 或 `global`。全局降级只能由安全事件（`securityEvent: true`）触发，单个工作区故障不得升级为全局故障。
- **默认质量底线**：`minChars: 0`、禁用 `TODO` 与 `{{`；由进入模式时显式配置覆盖。
- **退出条件**：`minStableMinutes` 稳定窗口 + `requireQualityRecheck` 质量复检（默认必须勾选通过）。

进入与退出必须显式操作，并写入审计：

- 审计表 `degradation_audit` 记录 `enter`、`exit`、`blocked` 三类动作。
- `read_only` 阻断 prepare/execute/route/deliver，`degraded` 阻断 fail-closed stage 与不达标的交付。

## 执行拦截点

| 入口 | 行为 |
|---|---|
| `packages/engine` `createDegradationGuard` | 包装 `preparePackRun` / `executePackStage` / `deliverPackRun`，local runner 与 Temporal worker 共用 |
| `apps/runtime` `EventRouter` | 只读时跳过新事件触发的 workflow，并写 `blocked` 审计 |
| `apps/web` `/api/runs`、`/api/jobs`、`/api/office/missions` | 只读时返回 `423`，不创建新任务 |

## 运维入口

- 控制台 `/degradation`：进入/退出模式、查看生效模式、依赖姿态与审计记录。
- 控制台顶部横幅：轮询 `/api/degradation`，显式展示当前降级/只读状态。
- API：`GET /api/degradation`、`POST /api/degradation/enter`、`POST /api/degradation/exit`。

## 降级演练（61 §3.2、§3.4、§5）

`scripts/degradation-drill.ts` 独立演练租户级（workspace）与全局（global）降级。默认 dry-run，`--execute` 才会写记录：

```powershell
bun run drill:degradation                          # dry-run：打印两类演练计划
bun run drill:degradation --execute                # 依次执行 workspace + global
bun run drill:degradation --execute --scope workspace
bun run drill:degradation --execute --scope global
bun run drill:degradation --execute --workspace tenant-a --executed-by operator:alice
```

若目标 scope/workspace 已存在 active 降级，脚本拒绝覆盖线上状态并以非零退出码结束（默认 workspace 为 `drill-degradation`，不会误伤真实租户）。

每次演练（两类互相独立）执行并校验：

1. **进入**：`enterDegradedMode` 显式进入模式并写入 `degradation_state` 与 `enter` 审计；租户级进入 `degraded`，全局（安全事件）进入 `read_only`；`exitCriteria` 为 `minStableMinutes=0`、`requireQualityRecheck=true`。
2. **隔离**：workspace 演练确认同 scope 其他 workspace 不受影响；global 演练确认模式覆盖任意 workspace，且只读会阻断新执行。
3. **质量底线**：合规输出通过、含占位符（`TODO`/`{{`）的输出被拦截。
4. **退出闸门**：不带质量复检的退出必须被拒绝；带通过复检的退出才被接受。
5. **恢复校验**：`markExited` 后持久化记录为 `exited`、不再出现在 `listActive()`、`enter`/`exit` 审计齐全。
6. **全局仅限安全事件**：global 演练先断言无 `securityEvent` 的进入抛 `DegradationContractError`（`global_requires_security_event`），再用 `securityEvent=true` 进入。

记录复用既有持久化，不新增记录器：

- `degradation_state` / `degradation_audit`：状态迁移与审计（控制台 `/degradation` 可见）。
- `runbook_drills`：通过 `newRunbookDrill` + `store.drills` 记录，modeId 为触发依赖；若该 mode 无 active runbook，先用 `scripts/runbook-templates.ts` 的默认模板播种（与 `runbook:drill --seed-runbooks` 相同内容），因此演练后 `runbookCoverage` 会把该 mode 计入已覆盖。

任一校验失败时脚本以非零退出码结束，并仍写入 `outcome=fail` 的 drill 记录（若已成功进入模式）。

## 验收对照（61 §5）

- 降级期间对外输出 100% 过质量底线：交付前 `evaluateQualityFloor` 阻断并审计。
- 单 workspace 故障触发全局降级 = 0：`enterDegradedMode` 强制全局需安全事件；守卫按 workspace 解析模式。
- 显式切换与审计：进入/退出均写 `degradation_audit`，UI 横幅展示。
