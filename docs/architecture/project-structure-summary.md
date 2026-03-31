# 项目架构梳理

## 1. 项目定位

这是一个以 **`gpt-5.4` 总控层**为编排中枢、以 **`gpt-5.3-codex` 执行层**承接具体编码产出的多智能体协同开发助手，目标是把架构设计、编码执行、代码审查、安全审计、测试、部署和 UI 检查串成一套可复用的个人开发工作流。

当前仓库采用“总控模型 + 执行模型”设计：

- **控制与编排层**：`gpt-5.4` 总控会话 + `.claude/` 指令、命令、Hooks
- **可视化与执行扩展层**：Web Dashboard + `mcp-server-codex`

其中 Dashboard 是可选观察层，`mcp-server-codex` 是默认执行扩展层。项目当前仍沿用 `.claude/` 命名组织工作流配置，但模型职责已经调整为 `gpt-5.4` 负责设计与编排、`gpt-5.3-codex` 负责具体编码实现。

## 2. 顶层目录结构

```text
/data/claude_moreagent
├── CLAUDE.md
├── .claude/
├── docs/
│   └── architecture/
├── src/
│   ├── dashboard/
│   └── mcp-server-codex/
├── infra/
├── tests/
└── claude_gaoji_backup_20260329_134257.tar.gz
```

各目录职责如下：

- `CLAUDE.md`
  项目级总说明，定义系统目标、Agent 角色和顶层目录含义。
- `.claude/`
  项目工作流配置中心，包含 MCP Server 注册、Hooks、slash commands 和 Dashboard 辅助脚本。
- `docs/architecture/`
  架构设计文档。`multi-agent-architecture.md` 偏方案设计，本文件偏项目落地视图。
- `src/dashboard/`
  Web 控制台，负责状态观察、实时日志、流程可视化和人工干预。
- `src/mcp-server-codex/`
  将 OpenAI Codex 封装成 MCP Server，供 `gpt-5.4` 总控层作为外部编码执行器调用。
- `infra/`
  预留给基础设施、部署或环境编排相关内容，目前未展开。
- `tests/`
  预留测试目录，目前未展开。

## 3. 核心架构分层

系统可以拆成 5 层：

### 3.1 用户交互层

- `gpt-5.4` 总控会话
- Web Dashboard

CLI 是主入口；Dashboard 是补充入口。

### 3.2 编排层

由 `gpt-5.4` 总控层承担：

- 需求理解
- 任务拆解
- Agent 角色切换
- slash command 调度
- 结果审查与回收

这一层的配置主要落在：

- `.claude/commands/*.md`
- `CLAUDE.md`
- `.claude/settings.json`

### 3.3 工具接入层

通过 MCP Servers 暴露外部能力，当前配置文件在 [settings.json](/data/claude_moreagent/.claude/settings.json)：

- 通用工具：`filesystem`、`fetch`
- 研发工具：`github`、`postgres`、`sqlite`
- 自动化与运维：`playwright`、`docker`、`kubernetes`、`aws`、`cloudflare`
- 协作工具：`slack`、`linear`、`notion`、`sentry`、`figma`
- 自定义执行器：`codex`

其中 `codex` 指向：

```json
"codex": {
  "command": "node",
  "args": ["src/mcp-server-codex/dist/index.js"]
}
```

说明系统预期把 `mcp-server-codex` 编译后作为本地 MCP 进程接入，并以 `gpt-5.3-codex` 作为默认执行模型。

### 3.4 状态与观察层

由 Dashboard 方案承担，目标包括：

- 会话记录
- Agent 执行记录
- 实时事件流
- 控制信号
- 历史审计

设计上依赖：

- SQLite 持久化
- Event Bus 实时广播
- WebSocket 推送给前端

### 3.5 外部执行层

由 `mcp-server-codex` 连接 OpenAI Responses API 承担，负责：

- 接收 `gpt-5.4` 构造的编码任务包
- 调用 Codex 云端沙箱
- 轮询与返回生成结果
- 支持任务取消与状态跟踪

## 4. Agent 体系

从文档和命令命名看，项目定义了 6 个显式命令角色，加上通用编码角色，形成完整协同体系：

- `architect`：架构设计、技术选型、契约设计
- `review`：代码审查、质量把关
- `security-audit`：安全扫描与风险分析
- `test-gen`：测试策略与测试生成
- `deploy`：CI/CD、容器化、部署方案
- `ui-check`：UI 质量、可访问性、交互检查
- `coder`：文档里存在的执行角色，主要依赖 `gpt-5.3-codex` 承担

这套体系说明项目不是把“多智能体”做成独立运行时，而是把它做成 **以 `gpt-5.4` 为总控的角色化编排工作流**。

## 5. Dashboard 子系统

Dashboard 位于 `src/dashboard/`，是一个前后端分离但同仓库开发的子项目。

### 5.1 后端

目录：

```text
src/dashboard/server/
├── index.ts
├── routes/
├── services/
├── ws/
└── db/
```

职责拆分：

- `index.ts`
  Fastify 入口，负责路由注册、WebSocket、数据库初始化、静态资源托管。
- `routes/`
  HTTP API 边界层：
  - `sessions.ts`：会话管理
  - `agents.ts`：Agent 运行管理与控制
  - `trigger.ts`：手动触发 Agent
  - `config.ts`：配置管理
  - `history.ts`：历史与审计
- `services/`
  业务逻辑层：
  - `session-service.ts`
  - `agent-service.ts`
  - `config-service.ts`
  - `event-bus.ts`
- `ws/`
  WebSocket 连接和消息协议。
- `db/`
  SQLite schema 和数据库说明。

### 5.2 前端

目录：

```text
src/dashboard/client/src/
├── main.tsx
├── App.tsx
├── pages/
├── components/
├── stores/
├── hooks/
└── api/
```

职责拆分：

- `main.tsx`
  React 应用入口。
- `App.tsx`
  路由与全局壳层。
- `pages/`
  页面级视图：
  - `Overview`
  - `Sessions`
  - `SessionDetail`
  - `Agents`
  - `Config`
  - `History`
- `components/`
  可复用业务组件，如流程图、日志查看器、控制面板、状态徽章等。
- `stores/`
  Zustand 状态管理，负责会话与 WebSocket 状态聚合。
- `hooks/`
  页面级实时订阅逻辑。
- `api/`
  REST API 调用封装。

### 5.3 前后端通信

Dashboard 采用两条通路：

- **REST API**
  用于列表、详情、触发、配置读写等请求响应式操作。
- **WebSocket**
  用于会话和 Agent 的实时状态与日志推送。

这意味着它是一个典型的“查询走 HTTP、增量走 WS”的观察控制台。

## 6. mcp-server-codex 子系统

目录：

```text
src/mcp-server-codex/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── codex-client.ts
    ├── task-store.ts
    ├── types.ts
    └── tools/
```

职责拆分：

- `index.ts`
  MCP Server 入口，负责注册工具并通过 stdio 与 `gpt-5.4` 总控层通信。
- `codex-client.ts`
  OpenAI Responses API 封装，负责提交和取消任务。
- `task-store.ts`
  本地任务状态缓存，默认是进程内存态。
- `types.ts`
  工具输入输出和内部数据结构定义。
- `tools/`
  MCP 工具接口：
  - `submit-task.ts`
  - `get-result.ts`
  - `list-tasks.ts`
  - `cancel-task.ts`

这是一个非常清晰的“协议层 + 客户端层 + 状态层”三段式结构。

## 7. Hook 与控制链路

Dashboard 并不直接控制总控进程，而是通过 Hook 和状态表做“协作式控制”。

相关脚本位于：

```text
.claude/scripts/dashboard/
├── event-emitter.sh
├── checkpoint.sh
└── session-manager.sh
```

作用分别是：

- `session-manager.sh`
  创建/结束 session 和 agent_run。
- `event-emitter.sh`
  将编辑、提交、推送、步骤事件写入状态层。
- `checkpoint.sh`
  在步骤边界检查控制信号，实现暂停、跳过、重试、终止。

这说明项目的控制模型不是强杀进程，而是：

1. Dashboard 写控制信号
2. Agent 在检查点读取信号
3. Agent 按信号协作式改变执行流程

这种方式更稳，更适合 CLI 工作流。

## 8. 关键调用链

### 8.1 `gpt-5.4` 驱动的标准流程

```text
开发者 -> GPT-5.4 总控会话
       -> slash command / 主会话
       -> 读取 .claude/settings.json
       -> 调用 MCP Server / Hooks
       -> 执行对应 Agent 工作
```

### 8.2 带 Codex 的编码执行流程

```text
GPT-5.4
-> 调用 codex.submit_task
-> mcp-server-codex 组装请求
-> OpenAI Responses API / Codex 沙箱
-> 返回 files/logs/result
-> GPT-5.4 审查并决定是否写回本地
```

### 8.3 Dashboard 观察流程

```text
Hook 脚本 / Session 脚本
-> 写入 SQLite / 发出事件
-> Dashboard Backend 读取和广播
-> Browser 通过 REST + WebSocket 展示状态
```

## 9. 当前实现状态

当前仓库已经不是“蓝图阶段”，而是**可运行的多智能体工作台实现**，并且关键链路已经打通。

已落地能力（核心）：

- `Dashboard` 前后端可运行，支持项目管理、会话创建、会话详情、历史/审计查询
- 编排主链路可执行：`architect -> coder -> reviewer -> tester(prep) -> awaiting_approval`
- 模型职责已固化：`gpt-5.4` 总控（规划/评审），`gpt-5.3-codex` 执行编码
- 控制链路可用：`pause/resume/skip/retry/abort`，并带安全策略（`skip/retry` 按 phase/trigger 限制）
- 事件链路已闭环：
  - WebSocket 实时推送
  - SSE 兜底通道（`GET /api/stream`）
  - Hook -> `POST /api/internal/notify` -> Event Bus -> 前端展示
- 事件总线支持双模式：
  - 默认 `emitter`（进程内）
  - 可选 `redis`（缺依赖或缺配置时自动降级）
- 审计与追踪：`control_signal`、`control_applied`、会话状态、Agent 状态变更均可追溯

当前仍建议持续完善的部分：

- `coder` 远程任务的 `pause/resume` 属于协作式软控制，不是底层任务硬暂停
- `retry` 在部分触发场景下仍是保守策略，建议后续补“真正重试执行语义”
- `mcp-server-codex` 与 Dashboard 目前是并行子系统，尚未统一成可切换 provider
- 历史遗留会话可能长期 `running`（外部中断导致），可补后台清理与恢复策略

## 10. 建议的后续落地顺序

建议按“稳定性优先”继续推进：

1. 补强控制语义
   明确 `pause/resume/retry/skip` 在各 phase 的执行契约，并补端到端自动化验收脚本。
2. 统一执行 Provider
   在 Dashboard 增加 `CODEX_PROVIDER`（例如 `responses|mcp`）并抽象统一接口。
3. 完善会话恢复机制
   为异常中断会话增加“自动超时收敛 + 手动恢复/关闭”能力。
4. 补齐发布级验证
   增加链路级 smoke tests（REST + WS/SSE + internal notify + control actions）与文档化验收清单。
