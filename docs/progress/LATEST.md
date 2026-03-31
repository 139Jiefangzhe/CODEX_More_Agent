# 最新进度入口

当前最新记录：`2026-03-30`
最新补充：`项目登记实操 + Django 学习平台示例（晚间）`
晚间补充定位：见 `docs/progress/2026-03-30-progress.md` 第 6 节

请先阅读：

1. `docs/progress/2026-03-30-progress.md`
2. `docs/architecture/2026-03-30-four-item-remediation.md`

---

## 晚间补充快速定位（架构文档 / 使用方法 / 多智能体使用方法）

1. `docs/progress/2026-03-30-progress.md`（第 6 节：项目登记字段、LearnHub 示例、首轮 Goal 模板）
2. `docs/architecture/architecture-usage-guide.md`（架构使用方法与 API 最小流程）
3. `docs/architecture/multi-agent-architecture.md`（多智能体架构与工作流设计）
4. `src/dashboard/README.md`（本地部署、环境变量与运行方式）

---

## 明天继续执行（最短路径）

```bash
cd /data/claude_moreagent/src/dashboard
npm run dev:server
```

可选前端：

```bash
cd /data/claude_moreagent/src/dashboard
npm run dev:client
```

快速确认：

```bash
curl -sS http://127.0.0.1:3100/api/health
```

---

## 明日优先级

1. 把 `tests/architecture` 脚本接入 CI 定时回归。
2. 完成 `session_dispatch_jobs` 清理与归档策略（避免长周期膨胀）。
3. 推进下一阶段控制面外置：将 planner/reviewer 链路迁移到 MCP 控制面服务。
