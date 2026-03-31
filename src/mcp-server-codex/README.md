# mcp-server-codex

将 OpenAI Codex 封装为 MCP Server，供 `gpt-5.4` 总控层作为代码执行层调用，默认执行模型为 `gpt-5.3-codex`。

## 架构

```
GPT-5.4 总控层
    │
    └── MCP 协议 (stdio)
         │
         ▼
    mcp-server-codex
    ┌────────────────────────────────┐
    │  Tools:                        │
    │  ├── codex.submit_task         │
    │  ├── codex.get_result          │
    │  ├── codex.list_tasks          │
    │  └── codex.cancel_task         │
    │                                │
    │  codex-client.ts               │
    │  └── OpenAI Responses API      │
    │                                │
    │  task-store.ts                 │
    │  └── 内存任务状态管理           │
    └────────────────────────────────┘
         │
         ▼
    OpenAI Codex 云端沙箱
```

## 工作流

1. `gpt-5.4` 构造任务包（prompt + 上下文文件 + 编码约束）
2. 调用 `codex.submit_task` → 返回 task_id
3. 调用 `codex.get_result` 查询结果（可能需多次轮询）
4. `gpt-5.4` 审查代码 → 通过则写入本地文件 / 不通过则重新提交

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `OPENAI_API_KEY` | 是 | - | OpenAI API 密钥 |
| `CODEX_MODEL` | 否 | `gpt-5.3-codex` | Codex 模型名称 |
| `CODEX_TIMEOUT` | 否 | `300` | 任务超时（秒） |
| `DASHBOARD_DB` | 否 | - | Dashboard SQLite 路径（可选持久化） |

## 目录结构

```
src/mcp-server-codex/
├── package.json
├── tsconfig.json
├── README.md              # 本文件
└── src/
    ├── index.ts           # MCP Server 入口（stdio transport）
    ├── tools/
    │   ├── submit-task.ts # 提交编码任务
    │   ├── get-result.ts  # 获取执行结果
    │   ├── list-tasks.ts  # 列出所有任务
    │   └── cancel-task.ts # 取消任务
    ├── codex-client.ts    # OpenAI Responses API 客户端
    ├── task-store.ts      # 任务状态管理
    └── types.ts           # 共享类型定义
```

## 详细设计

见 `docs/architecture/multi-agent-architecture.md` 第八章。
