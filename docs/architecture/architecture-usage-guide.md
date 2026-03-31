# Multi-Agent Dashboard 架构使用手册

更新时间：2026-03-30

## 1. 架构分层与职责

### 1.1 控制与展示层
- **Dashboard 前端**：`src/dashboard/client`
- **Dashboard 后端 API**：`src/dashboard/server`
- **职责**：项目管理、会话触发、审批、Agent 控制、历史审计、配置管理

### 1.2 编排与执行层
- **Orchestrator**：`server/services/orchestrator-service.ts`
- **执行提供者**：`execution-provider`（当前为 `responses`）
- **职责**：规划 -> 编码 -> 评审 -> 测试 -> 审批 -> 应用变更

### 1.3 状态层
- **SQLite**：`src/dashboard/data/dashboard.db`
- **Event Bus**：默认 `emitter`（可切 Redis）
- **职责**：持久化会话/变更/审计，向前端推送实时事件

### 1.4 实时通道
- **WebSocket**：`/ws`
- **SSE 回退**：`/api/stream`
- **职责**：实时状态变化和 Agent 事件推送

## 2. 当前运行配置（本机）

- systemd 服务：`claude-moreagent-dev.service`
- 启动命令：`npm run dev`
- API 健康检查：`GET /api/health`
- 鉴权：受保护接口需 `x-dashboard-token`
- 环境文件：`/etc/claude-moreagent/dashboard-dev.env`

常用验证命令：

```bash
systemctl is-active claude-moreagent-dev.service
curl -sS http://127.0.0.1:3100/api/health
```

## 3. 使用流程（推荐）

### 3.1 启动与登录
1. 浏览器访问 Dashboard 页面（开发模式通常是 `http://<host>:5173`）。
2. 首次进入会显示 Token 输入页。
3. 输入与服务端一致的 `DASHBOARD_TOKEN` 后进入主界面。

### 3.2 项目登记
- 在「项目」页新增项目，项目目录必须位于 `WORKSPACE_ROOTS` 允许范围内。
- 后端接口：`POST /api/projects`

### 3.3 发起会话
- 在项目中输入目标（Goal）并触发。
- 后端接口：`POST /api/sessions`
- 会话相位通常为：
  - `planning`
  - `implementing`
  - `awaiting_approval`
  - `applying`
  - `testing`（按配置）
  - `completed` / `failed` / `aborted`

### 3.4 审批与应用
- 审批通过：`POST /api/sessions/:id/approve`
- 拒绝：`POST /api/sessions/:id/reject`
- 终止：`POST /api/sessions/:id/abort`

### 3.5 观察与治理
- 会话详情：`GET /api/sessions/:id`
- Agent 事件：`GET /api/agents/:runId/events`
- 历史记录：`GET /api/history`
- 审计日志：`GET /api/audit-log`
- 控制面状态：`GET /api/control-plane`

## 4. API 最小可复现流程（curl）

先加载 token：

```bash
set -a
. /etc/claude-moreagent/dashboard-dev.env
set +a
```

创建项目：

```bash
curl -sS -X POST http://127.0.0.1:3100/api/projects \
  -H 'Content-Type: application/json' \
  -H "x-dashboard-token: ${DASHBOARD_TOKEN}" \
  -d '{
    "name": "Todo Demo",
    "root_path": "/data/claude_moreagent/demo/todo-demo",
    "language": "typescript",
    "framework": "node",
    "test_command": "npm test",
    "build_command": "npm run build",
    "ignore_paths": ["node_modules", "dist"]
  }'
```

发起会话：

```bash
curl -sS -X POST http://127.0.0.1:3100/api/sessions \
  -H 'Content-Type: application/json' \
  -H "x-dashboard-token: ${DASHBOARD_TOKEN}" \
  -d '{
    "projectId": "<project-id>",
    "goal": "为 demo 新增 /health 接口并补充 README 使用说明"
  }'
```

审批应用：

```bash
curl -sS -X POST http://127.0.0.1:3100/api/sessions/<session-id>/approve \
  -H 'Content-Type: application/json' \
  -H "x-dashboard-token: ${DASHBOARD_TOKEN}" \
  -d '{"runTests": false}'
```

## 5. 本次 Demo 实测结果（2026-03-30）

### 5.1 Dashboard 编排链路
- Demo 项目已创建：`Todo Demo`
- Demo 会话：`3734586a-27f7-4ea2-a332-249351213dd7`
- 流转结果：
  - `planning` -> `implementing` -> `awaiting_approval` -> `applying` -> `completed`
- Agent 运行结果：architect/coder/reviewer/tester 均完成，审批后应用阶段完成

### 5.2 Demo 项目运行验证
目录：`/data/claude_moreagent/demo/todo-demo`

验证命令：

```bash
cd /data/claude_moreagent/demo/todo-demo
node src/index.ts
# 新终端执行
curl -sS http://127.0.0.1:3000/health
```

实测结果：
- HTTP 状态：`200`
- 响应体：`{"status":"ok"}`

## 6. 故障排查

### 6.1 `Invalid or missing x-dashboard-token`
原因：
- 请求命中了受保护接口（如 POST/PUT/PATCH/DELETE 或 `/api/config/*`）但未带正确 token。

处理：
- 前端登录页输入正确 token；
- 或 API 请求头补充：`x-dashboard-token: <DASHBOARD_TOKEN>`。

### 6.2 会话长期卡住或失败
优先检查：
- `journalctl -u claude-moreagent-dev.service -n 200 --no-pager`
- 上游模型服务连通性（超时、鉴权、base URL）
- `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 是否正确

### 6.3 开机自启动检查

```bash
systemctl is-enabled claude-moreagent-dev.service
systemctl status claude-moreagent-dev.service --no-pager
```
