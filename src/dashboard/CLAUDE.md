# Dashboard 开发规范

## 技术栈

- 后端: Node.js + Fastify + TypeScript + better-sqlite3
- 前端: React 18 + TypeScript + Vite + TailwindCSS
- 状态管理: Zustand
- 实时通信: WebSocket (@fastify/websocket)
- 共享类型: `shared/types.ts`（前后端共用，修改时需同步检查两端引用）

## 开发约定

### 后端
- 路由文件只做参数校验和响应格式化，业务逻辑放 `services/`
- 数据库操作使用 better-sqlite3 同步 API（SQLite 单线程安全）
- 所有写操作必须同时写入 `audit_log`
- 配置修改（MCP/Hook/Command）同步到 `.claude/settings.json` 前必须备份

### 前端
- 页面组件放 `pages/`，可复用组件放 `components/`
- 状态管理使用 Zustand store，不使用 React Context
- WebSocket 订阅通过 `useWebSocket` hook 管理生命周期
- 危险操作（abort、delete、sync）必须使用 `ConfirmDialog` 二次确认

### 共享
- 所有数据类型定义在 `shared/types.ts`，前后端通过 import type 引用
- 新增 API 端点时，同步更新 `shared/types.ts` 中的请求/响应类型

## 核心原则

- Dashboard 是可选观察层，不运行时 Agent 零影响
- Hook 脚本失败必须静默退出（exit 0），不阻塞 Agent
- 所有外部通信（curl 通知）失败必须静默忽略
