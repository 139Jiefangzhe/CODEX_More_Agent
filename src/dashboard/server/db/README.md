# 数据库层（State Layer）

## 职责

Dashboard 系统的持久化核心，负责存储所有 Agent 执行事件、控制信号和审计日志。
作为 Agent 系统与 Dashboard 之间的解耦桥梁。

## 技术选型

- **默认**: SQLite — 零配置，单文件 `data/dashboard.db`
- **可选**: Postgres — 多用户/高并发场景，通过 `DATABASE_URL` 环境变量切换

## 核心表

| 表 | 职责 | 写入方 | 读取方 |
|---|---|---|---|
| `sessions` | 会话生命周期 | Hook 脚本 / Dashboard API | Dashboard 前端 |
| `agent_runs` | Agent 执行记录 | Hook 脚本 / Dashboard API | Dashboard 前端 |
| `agent_events` | 细粒度事件流 | Hook 脚本 (event-emitter.sh) | Dashboard 前端 (WebSocket) |
| `control_signals` | 控制指令 | Dashboard API | Hook 脚本 (checkpoint.sh) |
| `audit_log` | 审计日志 | 所有写操作触发 | Dashboard 历史页 |

## 文件结构

```
db/
├── schema.sql          # 建表语句 + 索引
├── README.md           # 本文件
├── migrations/         # 未来版本迁移脚本（预留）
│   └── 001_init.sql
└── seed.sql            # 开发用测试数据（预留）
```

## 关键设计决策

1. **SQLite WAL 模式**: 启用 WAL 以支持并发读写（Hook 写入 + API 读取）
2. **JSON 字段**: event_data/metadata/details 使用 JSON 类型，保持 schema 灵活性
3. **未消费信号索引**: `control_signals` 表对 `consumed_at IS NULL` 建部分索引，checkpoint.sh 查询高效
4. **审计不可变**: `audit_log` 只追加不修改不删除
