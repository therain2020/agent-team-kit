# 回滚演练与 RTO 证据

`scripts/rollback-drill.ts` 实现 `70-evolution-plane.md` §5「回滚演练通过」与
`85-autonomy-1.0.md` §3.5.6 的可复跑证据：对**一次代码变更**和**一次指令变更**
各执行一次回滚，测量耗时，断言 RTO ≤ 10 分钟，并产出与 gate-report G6 同口径的
记录。

## 为什么不是第二套回滚

演练直接调用 `executeChangeRollback`（`@kit/change/rollback`）——也就是
`kitd rollback -Change` → `scripts/change-rollback.ts` 使用的同一个执行器：

- 代码变更：只 `git revert` 提案记录的那个 commit，在 86 单写者 apply 锁下执行；
- 指令变更：重新校验 backup 哈希后才恢复变体文件；
- 两者都会把提案迁移到 `rolled_back` 并追加 repo-external 回滚审计。

演练不新增任何回滚实现，只把这两条既有路径跑一遍并计时。

## 运行

```powershell
bun run drill:rollback                 # dry-run：打印演练计划与目标 RTO，无副作用
bun run drill:rollback --execute       # 执行演练，写 G6 兼容报告
bun run drill:rollback --execute --out docs/evidence/rollback-drill-<stamp>.json
bun run drill:rollback --execute --executed-by operator:alice --workspace drill-rollback
bun run drill:rollback --execute --keep-workdir   # 保留临时仓库/审计便于排查
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--execute` | 否 | 不加只做 dry-run |
| `--out <file>` | `<home>/audit/rollback-drill-<stamp>.json` | 报告路径；`<home>` 为 `KIT_HOME` 或 `~/.agent-team-kit` |
| `--executed-by` | `operator:rollback-drill` | 记录在提案与 drill 行的 actor |
| `--workspace` | `drill-rollback` | 临时提案的 workspace |
| `--repo` | 当前目录 | 读取并记录被测检出的 commit SHA（必须在 git 仓库内运行） |
| `--keep-workdir` | 否 | 保留 `%TEMP%\kit-rollback-drill-*` |

## 演练内容

完全隔离，不触碰当前检出、操作者数据库或在线 kitd：

1. 临时 git 仓库：baseline → 代码变更 commit → 之后一个无关 commit；
2. `ChangeProposal`（substrate `code`，`revert.kind=code`）→ 执行回滚；
3. 临时变体目录：baseline 备份 + 新的 `agents/writer.md`；
4. `ChangeProposal`（substrate `prompt`，`revert.kind=instruction`）→ 执行回滚；
5. 临时 SQLite store 与临时回滚审计 `change-rollback.jsonl`；结束时清理
   （`--keep-workdir` 除外）。

每项回滚校验：

- 状态为 `ok`，提案迁移到 `rolled_back`；
- 代码：只回滚自己的 commit，后续无关 commit 保留，HEAD 前进到新的 revert commit；
- 指令：`writer.md` 恢复到备份内容，备份哈希未变；
- 回滚审计有对应的 `code` / `instruction` 成功条目。

## RTO 口径

- 逐项用单调时钟测量 `executeChangeRollback` 的墙钟耗时；
- RTO 取两者**较坏值**（一次故障只需回滚一个变更），按分钟向上取整；
- 目标常量直接从 `scripts/gate-report/model.ts` 的 `GATE_RTO_TARGET_MINUTES`
  （10 分钟）导入，避免第二套阈值；
- 任一超过目标 → `rto-target` 检查失败，CLI 退出码 1。

## 证据与 G6 对齐

报告同时满足两处消费：

- `RecoveryDrill` 行：通过既有的 `newRecoveryDrill` + `store.drills` 记录，
  `script=scripts/rollback-drill.ts`，`measuredRtoMinutes` 为上述较坏值，
  `integrityPass` 为全部回滚校验结果；
- JSON 报告：沿用 `recovery-drill-*.json` 的字段
  （`finishedAt` / `outcome` / `recoverySeconds` / `checks[].pass`），文件名
  `rollback-drill-<stamp>.json`。`scripts/gate-report/collect.ts` 现在同时读取
  `recovery-drill-*` 与 `rollback-drill-*`，并优先使用报告自带的 `script` 字段。

因此 `bun run gates:report` 的 G6 对两类演练只有一套判定：`drill-pass`、
`rto-measured`、`rto-target`（≤ 10 分钟）、`integrity`、`no-open-incidents`。
把结果归档到 `docs/evidence/rollback-drill-<stamp>.json` 时，报告同时包含
被测检出的 commit SHA、开始/结束时间、两项回滚耗时与每项检查明细。

## 已知边界

- 本演练只测回滚耗时，不测数据丢失窗口（RPO）；RPO 由
  `bun run recovery:drill --execute --rpo-minutes <n>` 的季度演练负责。
- 不演练进程崩溃/健康检查驱动的 LKG 回滚；那是 `scripts/recovery-drill.ps1`
  `-Mode rollback` 的职责。
- 报告中的临时仓库 commit SHA 仅用于复现当次演练，临时目录默认删除；持久证据是
  报告 JSON。
