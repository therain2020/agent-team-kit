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

## 验收对照（61 §5）

- 降级期间对外输出 100% 过质量底线：交付前 `evaluateQualityFloor` 阻断并审计。
- 单 workspace 故障触发全局降级 = 0：`enterDegradedMode` 强制全局需安全事件；守卫按 workspace 解析模式。
- 显式切换与审计：进入/退出均写 `degradation_audit`，UI 横幅展示。
