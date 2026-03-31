# Multi-Agent Dashboard

多智能体协同开发助手的 Web 可视化控制台。

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  Browser (React SPA)                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ 总览页    │ │ 会话详情  │ │ 配置管理  │  ...       │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘            │
│        └────────────┼────────────┘                  │
│                     │                               │
│         REST API + WebSocket                        │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────┐
│  Backend (Node.js + Fastify)                        │
│  ┌────────┐ ┌───────────┐ ┌──────────┐             │
│  │ Routes │ │ Services  │ │ WS Server│             │
│  └───┬────┘ └─────┬─────┘ └────┬─────┘             │
│      └────────────┼─────────────┘                   │
│                   │                                 │
│         ┌─────────┴─────────┐                       │
│         │    Event Bus      │                       │
│         └─────────┬─────────┘                       │
│                   │                                 │
│         ┌─────────┴─────────┐                       │
│         │  SQLite / Postgres │                      │
│         └───────────────────┘                       │
└─────────────────────────────────────────────────────┘
                      ▲
                      │ Hook 脚本写入事件 / 读取控制信号
                      │
┌─────────────────────┴───────────────────────────────┐
│  GPT-5.4 总控层 + Agents                            │
│  ┌──────────────────────────────────┐               │
│  │ .claude/scripts/dashboard/       │               │
│  │  ├── event-emitter.sh            │               │
│  │  ├── checkpoint.sh               │               │
│  │  └── session-manager.sh          │               │
│  └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

## 目录结构

```
src/dashboard/
├── package.json                 # 依赖声明
├── tsconfig.json                # TypeScript 配置
├── README.md                    # 本文件
│
├── server/                      # 后端
│   ├── index.ts                 # Fastify 入口
│   ├── routes/                  # API 路由
│   │   ├── sessions.ts          #   会话管理
│   │   ├── agents.ts            #   Agent 运行 + 控制
│   │   ├── trigger.ts           #   手动触发 Agent
│   │   ├── config.ts            #   配置管理（MCP/Hook/Command）
│   │   └── history.ts           #   历史审计 + 统计
│   ├── services/                # 业务逻辑
│   │   ├── session-service.ts   #   会话 CRUD
│   │   ├── agent-service.ts     #   Agent CRUD + 控制信号
│   │   ├── config-service.ts    #   配置读写 + 同步
│   │   └── event-bus.ts         #   进程内事件总线
│   ├── ws/                      # WebSocket
│   │   ├── handler.ts           #   连接管理 + 推送
│   │   └── protocol.ts          #   消息协议定义
│   └── db/                      # 数据库
│       ├── schema.sql           #   建表语句
│       └── README.md            #   数据库层说明
│
├── client/                      # 前端
│   ├── index.html               # HTML 入口
│   ├── vite.config.ts           # Vite 配置
│   └── src/
│       ├── main.tsx             # React 入口
│       ├── App.tsx              # 路由 + 布局
│       ├── pages/               # 页面
│       │   ├── Overview.tsx     #   总览首页
│       │   ├── Sessions.tsx     #   会话列表
│       │   ├── SessionDetail.tsx#   会话详情（核心页）
│       │   ├── Agents.tsx       #   Agent 管理
│       │   ├── Config.tsx       #   配置管理
│       │   └── History.tsx      #   历史审计
│       ├── components/          # 组件
│       │   ├── WorkflowGraph.tsx    # 工作流可视化（ReactFlow）
│       │   ├── AgentControlPanel.tsx# 控制面板
│       │   ├── AgentLogViewer.tsx   # 实时日志
│       │   └── AgentStatusBadge.tsx # 状态徽章
│       ├── stores/              # 状态管理（Zustand）
│       │   ├── session-store.ts #   会话 + Agent 状态
│       │   └── ws-store.ts      #   WebSocket 连接状态
│       ├── hooks/               # React Hooks
│       │   └── useWebSocket.ts  #   WebSocket 订阅 hook
│       └── api/                 # API 客户端
│           └── client.ts        #   REST API 封装
│
└── data/
    └── dashboard.db             # SQLite 数据库（运行时生成）
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + TailwindCSS |
| 状态管理 | Zustand |
| 流程图 | @xyflow/react (ReactFlow) |
| 图表 | Recharts |
| 代码编辑 | Monaco Editor |
| 后端 | Node.js + Fastify |
| 数据库 | SQLite (better-sqlite3) |
| 实时通信 | WebSocket (@fastify/websocket) |
| 事件总线 | InMemory EventEmitter（默认） / Redis PubSub（可选） |

## 核心设计原则

1. **可选观察层**: Dashboard 不运行时，所有 Agent 正常工作，零影响
2. **解耦架构**: 通过状态层（SQLite + Event Bus）桥接，Agent 与 Dashboard 无直接依赖
3. **协作式控制**: 通过 checkpoint.sh 检查点实现暂停/跳过/终止，非强制中断
4. **优雅降级**: 所有 Hook 脚本在 Dashboard 不可达时静默退出

## 快速启动

```bash
cd src/dashboard

# 安装依赖
npm install

# 本地配置文件：编辑 .env，填入 OPENAI_API_KEY
# 启动开发服务器（前后端同时启动）
npm run dev

# 访问 http://localhost:5173
```

## 本地配置

运行时默认从 `src/dashboard/.env` 读取本地配置，模板文件见 `src/dashboard/.env.example`。

核心变量：

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://www.heiyucode.com
DASHBOARD_CONTROLLER_MODEL=gpt-5.4
CODEX_MODEL=gpt-5.3-codex
CODEX_TIMEOUT=600
CODEX_PROVIDER=responses
# CODEX_PROVIDER=mcp 时可选覆盖
# CODEX_MCP_COMMAND=node
# CODEX_MCP_ARGS=../mcp-server-codex/dist/index.js
# CODEX_MCP_CWD=../mcp-server-codex
CONTROL_PLANE_MODE=direct
PORT=3100
HOST=127.0.0.1
DATABASE_URL=./data/dashboard.db
```

说明：

- `OPENAI_API_KEY` 必填；未配置时 Dashboard 可以启动，但无法创建新工作会话
- `OPENAI_BASE_URL` 可选；如果走中转站，填中转地址。只填域名时，服务端会自动补成 `/v1`
- `DASHBOARD_CONTROLLER_MODEL` 默认是 `gpt-5.4`
- `CODEX_MODEL` 默认是 `gpt-5.3-codex`
- `CODEX_PROVIDER` 支持 `responses|mcp`，默认 `responses`
- `CONTROL_PLANE_MODE` 支持 `direct|queue`，默认 `direct`
- SQLite 数据库会在服务启动时自动初始化，不需要单独执行建表

## 详细设计

完整架构设计文档见 `docs/architecture/multi-agent-architecture.md` 第七章。
