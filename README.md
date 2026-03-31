# CODEX More Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Open Source](https://img.shields.io/badge/Open%20Source-Yes-blue)

面向多智能体协同开发场景的工程化仓库，包含可视化控制台、MCP 代码执行服务、架构文档与最小演示工程。

## 项目简介

该仓库的目标是把「总控 Agent -> 执行 Agent -> 可视化观测」串成一个可落地的最小闭环：

- `src/dashboard`：Web 控制台（前后端一体）
- `src/mcp-server-codex`：将 Codex 封装为 MCP Server（stdio）
- `demo/todo-demo`：轻量 demo 项目
- `docs/`：架构设计与进展记录

## 目录结构

```text
.
├── .claude/                    # 命令与脚本
├── demo/
│   └── todo-demo/              # 最小演示工程
├── docs/
│   ├── architecture/           # 架构文档
│   └── progress/               # 开发进展记录
├── infra/                      # 基础设施占位目录
├── projects/
│   └── learnhub/               # 项目占位目录
├── src/
│   ├── dashboard/              # 多智能体 Dashboard
│   └── mcp-server-codex/       # MCP Codex 服务
├── tests/
│   └── architecture/           # 架构验证脚本
├── .gitignore
├── CLAUDE.md
├── LICENSE
└── README.md
```

## 运行方式

### 环境要求

- Node.js 20+
- npm 10+
- 可用的 `OPENAI_API_KEY`

### 1) 启动 Dashboard（推荐先跑这个）

```bash
cd src/dashboard
cp .env.example .env
# 编辑 .env，至少填 OPENAI_API_KEY

npm install
npm run dev
```

默认前端地址：`http://localhost:5173`

### 2) 启动 MCP Server（可选）

```bash
cd src/mcp-server-codex
npm install
npm run dev
```

### 3) 运行 Demo（可选）

```bash
cd demo/todo-demo
npm run start
```

## 常用命令

### `src/dashboard`

```bash
npm run dev          # 前后端同时开发模式
npm run build        # 构建 server + client
npm run start        # 启动构建产物
npm run db:init      # 初始化数据库
```

### `src/mcp-server-codex`

```bash
npm run dev          # 开发模式
npm run build        # TypeScript 构建
npm run start        # 运行 dist
```

## 开源与安全说明

本仓库已按开源发布需要做默认排除，以下内容不会被纳入版本库：

- 私钥与证书类文件（如 `ssh_keys/`, `*.pem`, `*.key`）
- 本地环境变量文件（`**/.env*`，保留 `*.env.example`）
- 本地数据库与状态文件（`*.db`, `*.db-wal`, `*.db-shm`）
- 大体积依赖与构建产物（`node_modules/`, `dist/`）
- 本地备份压缩包（`*.tar.gz`, `*.zip`）

如需继续贡献，请保持同样的安全边界，不要提交密钥、令牌或本地数据。

## 文档入口

- Dashboard 详细说明：`src/dashboard/README.md`
- MCP Server 详细说明：`src/mcp-server-codex/README.md`
- 总体架构文档：`docs/architecture/multi-agent-architecture.md`

## License

MIT License，见 [LICENSE](./LICENSE)。
