# Agent Team Kit

**拥有你自己的 AI 团队 —— 带审批、审计与回滚。**

自托管、文件化的 Agent 团队：团队就是 YAML 和 Markdown，运行过程可审计，
外部副作用必须经过审批。它不是另一个 agent 库，而是让团队真正干活的
运行时加治理层。

- **团队即文件** —— 一个 Team Pack 就是 YAML 和 Markdown；可以 diff、评审、回滚。
- **默认玻璃盒** —— 每件产物都带来源、门禁与成本记录。
- **数据在你手里** —— 本地优先，无遥测，对外动作显式审批。

## 快速开始

需要 Bun 1.4+、Node 24、Docker Desktop（`kit demo` 不需要 Docker）。

```bash
bun install
bun run kit doctor          # 检查 Bun、Node、Docker、端口和模型 key
bun run kit demo            # 生成演示团队与静态计划，不依赖 Docker
bun run kit init packs/my-team --template research
bun run kit up --web        # 基础设施 + 运行时 + worker + autopilot + 控制台
```

打开 `http://localhost:3000/welcome` 填入模型 API key，或运行
`bun run kit bootstrap`。当前是 **0.9.0 自治预览**，1.0 尚未声称。1.0 =
信息驱动 + 自制造：信源持续驱动预定工作流，反应有效，资产与代码按风险自造，
人只观察/编辑/中断，恢复与审计在位；原“无人值守 + 自优化”为支撑条件（主门禁见
`98-information-driven-self-manufacture.md` §5.2）。验收门槛见
[ROADMAP.md](./ROADMAP.md)。

## 核心概念

- **Team Pack**：团队、角色（Seller / Builder / Specialist / Manager）、
  工作流、审批策略全部是文件。
- **Manager Console**：Office 任务板、Inbox 审批、Run 证据链、Pack Studio。
- **Pack Studio**：在浏览器里改人、改流程、改审批与自治，保存即校验。
- **Workshop**：从 GitHub topic 发现、预览、安装社区团队（`kit workshop`）。
- **Autopilot / Evolution**：定时运行、预算、自动审批、灰度与可回滚的演化。

## 文档

- [安装与运行](./docs/install.md)
- [团队包编写](./docs/pack-authoring.md)
- [开放平台与安全边界](./docs/open-platform.md)
- [路线图](./ROADMAP.md)

## 参与社区

- 贡献方式见 [CONTRIBUTING.md](./CONTRIBUTING.md)：写团队、写文档/翻译、改核心，三条路径。
- 提问与讨论见 [SUPPORT.md](./SUPPORT.md)；安全漏洞只走 [SECURITY.md](./SECURITY.md)。
- 分享团队：把 pack 发到自己的仓库并打上 `agent-team-workshop` topic，
  或提交 "Team pack submission" issue。
- 行为准则：[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE)。
