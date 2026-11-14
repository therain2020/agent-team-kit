# CLAUDE.md — agent-team-kit

## 最高原则（不可协商）

**一切从长期最佳出发。** 本项目的任何决策（架构、契约、实现、依赖、演化）先问：三年后回头看，这仍然是对的选择吗？

- 短期权宜实现、绕过契约、隐藏技术债，不作为默认方案。
- 必须妥协时，明确写出长期代价与偿还计划，并记录到计划文档。
- 可靠性、可回放、可审计优先于功能数量与演示速度。
- 自我修改（autonomy）宁可慢，不可不可逆：必须走 85 的 1.0 门禁与 kitd 回滚。

## 核心上下文

- 设计基线：`D:\GitHub\plans\agent-pipeline`（`README.md` 为唯一入口；`85-autonomy-1.0.md` 为 1.0 门禁；`90-decisions.md` 为 ADR 日志；`REVIEW-2026-11-14.md` 为用户裁定）。
- 当前状态：0.9.0 自治预览；1.0 = 无人值守 + 自优化，尚未声称达成。
- 计划目录默认不纳入 git（D-15 拟定）；本仓库是实现代码。
- 修改计划文档或让实现偏离计划前，先与用户讨论（全局 Plan-First 规则）。

## Git 协作流程（Issue 驱动）

所有改变行为或契约的改动（功能、修复、重构、文档、工具链）必须按以下六步执行，顺序不可颠倒：
**计划 → issue → 认领 → 分支/PR → 合并并回写 → 清理 worktree**。纯拼写/链接修正可直接提 PR。

1. **Plan first** — 先在 `D:\GitHub\plans\agent-pipeline` 更新对应计划（改计划前先与用户讨论），明确范围、验收与代码边界。没有计划条目的改动不开工。
2. **计划挂到 issue** — 标题用 `[<计划切片>] <标题>`（如 `[61.6] run 单写者 lease`）。正文必须包含：
   - 父 issue（如有）
   - `计划依据：<文件名> §x.y`（引用章节，不复制全文）
   - 现状（审计到的既有实现与缺口）
   - 待实现（可检查的条目）
   - 验收（可量化）
   - 代码范围（涉及的 package/app 路径）
3. **领取 issue** — 开工前先 assign 并公开认领，避免并行 session 重复开工：
   ```powershell
   gh issue edit <n> --add-assignee therain2020
   gh issue comment <n> --body "claimed by <worktree/session 标识>"
   ```
   已被 assign 或已认领的 issue 不得重复开工。然后在独立 worktree 中执行：
   ```powershell
   git fetch origin
   git worktree add .claude/worktrees/<topic> -b feat/<n>-<slug> origin/develop
   ```
4. **新分支、新 PR** — 一个 issue 对应一个分支、一个 PR，只解决一个问题。分支从 `origin/develop` 切出（修复用 `fix/<n>-<slug>`），PR 目标为 `develop`；正文写明 `Closes #<n>`、计划依据、验证命令与结果，以及偏离计划的说明（如有）。
5. **合并并回写** — CI 全绿后 squash 合并：
   ```powershell
   gh pr merge <pr> --squash --delete-branch
   ```
   合并后按顺序回写：
   - 先更新计划文档的状态、验收结论与 ADR（偏离计划时尤其必须）；
   - 再在 issue 评论合并 commit 与偏差，然后关闭 issue；
   - 涉及发布时按需打 tag。
6. **清理 worktree** — 合并完成后立即移除本次 worktree，不要留到以后再清，避免磁盘膨胀：
   ```powershell
   git worktree remove .claude/worktrees/<topic>
   git worktree prune
   ```
   `git worktree remove` 遇到未提交改动会拒绝执行；先确认改动已合并或已明确丢弃，再移除。不得清理他人的 worktree。

### 约束

- `develop` 是集成分支，也是唯一的日常合并目标。`master` 为发布线，`feat/autonomy-0.9` 只是远端默认分支，二者都不是日常 PR 目标。
- 禁止直接 push `develop` / `master`；禁止对共享分支 force push。
- 并行 session 各自使用独立 worktree，不得改动他人 worktree。
- 计划文档默认不纳入 git（D-15）；issue 通过「文件 + 章节」引用计划，确保他人无需访问本地目录也能理解范围与验收。
- 无 issue、无计划依据、PR 与 issue 不对应的改动不合并。
