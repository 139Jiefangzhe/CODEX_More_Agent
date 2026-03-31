# 多智能体协同开发助手

## 项目概述

这是一个以 `gpt-5.4` 为总控模型、以 `gpt-5.3-codex` 为具体编码执行模型的多智能体协同开发系统，覆盖从架构设计到部署运维的完整开发生命周期。项目当前仍沿用 `CLAUDE.md` 和 `.claude/` 目录组织来承载命令、Hooks 和 MCP 配置，并提供 Web Dashboard 控制台进行可视化监控和流程干预。

## Agent 角色

本项目通过 slash commands 触发不同的专业 Agent 角色：

| 命令 | Agent | 职责 |
|------|-------|------|
| `/architect` | 架构师 | 系统设计、技术选型、API 设计 |
| `/review` | 代码审查员 | 代码审查、质量把关 |
| `/security-audit` | 安全工程师 | 安全审计、漏洞扫描 |
| `/test-gen` | 测试工程师 | 测试策略、测试编写 |
| `/deploy` | 运维工程师 | CI/CD、容器化、部署 |
| `/ui-check` | UI/UX 工程师 | 组件开发、可访问性检查 |

## Web Dashboard

Web 可视化控制台（`src/dashboard/`），提供：
- 流程可视化：查看 Agent 执行状态、日志、进度
- 进度干预：暂停/恢复/跳过/重试/终止 Agent
- 手动触发：从 UI 启动任意 Agent
- 配置管理：编辑 MCP Servers、Hooks、Slash Commands
- 历史审计：执行记录、甘特图时间线、统计报表

Dashboard 是可选的观察层，不运行时所有 Agent 正常工作。
详细设计见 `docs/architecture/multi-agent-architecture.md` 第七章。

## 双模型协同

系统采用 `gpt-5.4` + `gpt-5.3-codex` 双模型架构：
- **`gpt-5.4`（总控层）**: 需求理解、架构设计、任务拆解、代码审查、安全审计
- **`gpt-5.3-codex`（执行层）**: 通过 `mcp-server-codex` 集成，执行具体编码任务

`gpt-5.3-codex` 不替代 `gpt-5.4`，而是作为 Coder/Tester/DevOps/UI Agent 的默认执行引擎。
简单任务可由 `gpt-5.4` 直接完成，中大型编码任务交给 `gpt-5.3-codex` 批量生成后再由 `gpt-5.4` 审查。
详细设计见 `docs/architecture/multi-agent-architecture.md` 第八章。

## 模型路由规则

- `/architect`、`/review`、`/security-audit` 的主推理和最终决策默认由 `gpt-5.4` 完成。
- `/test-gen`、`/deploy`、`/ui-check` 中涉及批量代码、脚本、配置模板产出的部分，默认下发给 `gpt-5.3-codex`。
- 小范围修改、需要即时判断的修复、涉及架构取舍的实现细节，由 `gpt-5.4` 直接处理。
- 超过 20 行的标准功能开发、批量重构、测试代码生成，优先交给 `gpt-5.3-codex`，再由 `gpt-5.4` 做审查和收口。

## 通用规范

### 代码风格
- TypeScript/JavaScript: ESLint + Prettier，使用项目 `.eslintrc` 和 `.prettierrc`
- Python: Ruff 格式化 + 类型注解
- Go: gofmt + golangci-lint
- 所有语言：有意义的命名、小函数、单一职责

### Git 规范
- 提交信息格式: `<type>(<scope>): <description>`
- type: feat, fix, docs, style, refactor, test, chore, ci, perf, security
- 分支命名: `<type>/<short-description>`，如 `feat/user-registration`

### 安全原则
- 不硬编码任何密钥、token、密码
- 所有用户输入必须验证和转义
- 使用参数化查询，禁止字符串拼接 SQL
- 敏感数据传输必须加密
- 遵循最小权限原则

### 文档要求
- API 变更必须同步更新 OpenAPI/GraphQL schema
- 架构决策记录在 `docs/architecture/` 下
- README 保持最新

## 目录结构

```
├── CLAUDE.md              # 本文件 - 全局指令
├── .claude/
│   ├── settings.json      # MCP servers + hooks
│   ├── commands/          # Agent slash commands
│   └── scripts/dashboard/ # Dashboard Hook 脚本
├── docs/architecture/     # 架构设计文档
├── src/
│   ├── dashboard/         # Web Dashboard 控制台
│   │   ├── server/        # 后端（Fastify + SQLite）
│   │   ├── client/        # 前端（React + Vite）
│   │   └── shared/        # 前后端共享类型
│   └── mcp-server-codex/  # Codex MCP Server（代码执行层）
│       └── src/           # Tool 定义 + OpenAI API 客户端
├── tests/                 # 测试代码
├── infra/                 # 基础设施代码
└── .github/workflows/     # CI/CD
```
