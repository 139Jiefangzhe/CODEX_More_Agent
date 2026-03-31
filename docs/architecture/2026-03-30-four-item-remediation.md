# 四项致命缺陷修复与逐项验证（2026-03-30）

更新时间：2026-03-30（Asia/Shanghai）

## 目标

针对当前剩余的四项架构缺陷，执行“文档驱动修复”：

1. Dashboard 控制面与执行面耦合过深（未形成可切换 provider）。
2. 写槽（write slot）仍是内存轮询语义，缺少持久化队列与锁。
3. 缺少数据库级幂等主键（`session_id + phase + attempt`）。
4. 文件变更契约不完整（缺失 `delete/rename` 一等支持）。

---

## 项目基线

- 代码根目录：`/data/claude_moreagent`
- Dashboard 服务：`src/dashboard`
- Codex MCP 服务：`src/mcp-server-codex`

---

## 修复项 1：执行层 provider 解耦（responses | mcp）

### 问题

- Orchestrator 与单 Agent 执行直接绑定 `CodexExecutor`（Responses API）。
- 无法以配置开关切换到 MCP 工具链执行路径。

### 目标态

- Dashboard 使用统一 `execution provider` 接口。
- 支持 `CODEX_PROVIDER=responses|mcp`。
- `mcp` 模式通过 stdio MCP client 调用 `codex.submit_task/get_result/cancel_task`。

### 实现步骤

1. 新增 provider 抽象层与统一结果模型。
2. 实现 `responses provider`（兼容现有逻辑）。
3. 实现 `mcp provider`（stdio JSON-RPC 协议 + MCP initialize + tools/call）。
4. Orchestrator 与手动单 Agent 执行切换到统一 provider。
5. 增加配置项（provider、mcp server 命令、mcp server 参数）。

### 验收标准

- `CODEX_PROVIDER=responses` 时行为保持兼容。
- `CODEX_PROVIDER=mcp` 时 coder 任务可提交并返回结果。
- 控制动作（abort）可触发 cancel 路径。

### 验证命令

```bash
cd /data/claude_moreagent/src/dashboard
npm run build
```

```bash
# provider 配置检查
CODEX_PROVIDER=mcp node -e "console.log(process.env.CODEX_PROVIDER || 'unset')"
```

---

## 修复项 2：写槽 durable 队列与锁

### 问题

- `waitForWriteSlot` 依赖查询 running 会话 + sleep 轮询，缺少持久化队列语义。
- 进程重启后等待关系与锁持有关系不可恢复。

### 目标态

- 引入 DB 持久化写槽队列表与锁表。
- 获取写槽遵循先到先得（同项目范围）。
- 释放写槽为真实 DB 操作，事件只做观测面表达。

### 实现步骤

1. 新增 `write_slot_queue`、`write_slot_locks` 表。
2. 重写 `waitForWriteSlot`：入队、排位、尝试加锁、等待、获取。
3. 新增 `releaseWriteSlot` 与 stale lock 回收策略。
4. 在 session 终止路径统一释放（completed/failed/aborted/rejected）。

### 验收标准

- 排队期间产生 `slot_event(waiting)`，获取后产生 `slot_event(acquired)`。
- 释放后产生 `slot_event(released)` 且锁表无残留。
- 重启后队列状态可追踪，不出现“幽灵 reviewer 等待”。

### 验证命令

```bash
cd /data/claude_moreagent/src/dashboard
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('/tmp/dashboard-four-item.db');
const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('write_slot_queue','write_slot_locks') ORDER BY name").all();
console.log(rows);
NODE
```

```bash
cd /data/claude_moreagent/src/dashboard
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('/tmp/dashboard-four-item.db');
const rows=db.prepare("SELECT project_id, session_id, status FROM write_slot_queue ORDER BY id DESC LIMIT 10").all();
console.log(rows);
NODE
```

---

## 修复项 3：phase 级数据库幂等键

### 问题

- 当前 retry 与恢复虽有 `metadata.phase_attempts`，但缺少 DB 强约束防重入。
- 同 phase 同 attempt 在异常重放场景下可能重复执行。

### 目标态

- 建立 `UNIQUE(session_id, phase, attempt)` 的执行幂等记录表。
- planning/applying/testing 执行必须先过幂等门禁。
- 恢复场景对“running 悬挂记录”有明确收敛策略。

### 实现步骤

1. 新增 `phase_execution_attempts` 表与唯一约束。
2. 在 phase 执行入口统一 claim。
3. 执行成功/失败/中断后更新状态。
4. 启动恢复前收敛旧的 running 记录。

### 验收标准

- 同 `session+phase+attempt` 第二次进入被拒绝或复用，不会重复执行核心副作用。
- retry 后 `attempt+1` 可正常执行。

### 验证命令

```bash
cd /data/claude_moreagent/src/dashboard
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('/tmp/dashboard-four-item.db');
const rows=db.prepare("PRAGMA index_list('phase_execution_attempts')").all();
console.log(rows);
NODE
```

```bash
cd /data/claude_moreagent/src/dashboard
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('/tmp/dashboard-four-item.db');
const rows=db.prepare("SELECT session_id, phase, attempt, status FROM phase_execution_attempts ORDER BY id DESC LIMIT 20").all();
console.log(rows);
NODE
```

---

## 修复项 4：文件变更契约补全（create/modify/delete/rename）

### 问题

- 现有契约基本等价于“写入文件内容”，缺少 delete/rename 的一等语义。
- apply/rollback 快照仅覆盖 `path`，无法可靠覆盖 rename 回滚。

### 目标态

- 统一变更模型支持：
  - `create`
  - `modify`
  - `delete`
  - `rename`（包含 old/new path）
- apply 与 rollback 对四类操作全覆盖，兼容旧格式。

### 实现步骤

1. 扩展 codex 输出契约与归一化逻辑。
2. 更新 `buildChangeFiles` 与 diff 构建。
3. 更新 `GitService.applyFiles` 与 snapshot/rollback 覆盖 rename/delete。
4. 增加向后兼容映射（旧 `path+content`）。

### 验收标准

- 删除文件可正确落盘并在失败时恢复。
- 重命名文件可成功且回滚恢复源文件与目标文件状态。
- 旧格式任务不回归。

### 验证命令

```bash
cd /data/claude_moreagent/src/dashboard
npm run build
```

---

## 执行记录（逐项回填）

### 1) provider 解耦

- 状态：`已完成`
- 代码变更：
  - `src/dashboard/server/services/execution-provider.ts`（新增）
  - `src/dashboard/server/services/mcp-stdio-client.ts`（新增）
  - `src/dashboard/server/index.ts`（注入 `CODEX_PROVIDER` 配置与 provider 生命周期）
  - `src/dashboard/server/services/orchestrator-service.ts`（统一走 `executionProvider`）
  - `src/dashboard/server/routes/trigger.ts`（单 Agent 路径走统一 provider）
  - `src/dashboard/.env.example`、`src/dashboard/README.md`（新增 provider 配置说明）
- 验证结果：
  - 启动参数：`CODEX_PROVIDER=mcp`
  - 触发单 Agent 后，`tool_call` 事件为：
    - `tool: "mcp:codex.submit_task"`
    - `provider: "mcp"`
  - 证明执行层已从硬编码 Responses 切换为可配置 provider。

### 2) durable 写槽

- 状态：`已完成`
- 代码变更：
  - `src/dashboard/server/db/schema.sql`
    - 新增 `write_slot_queue`
    - 新增 `write_slot_locks`
  - `src/dashboard/server/services/orchestrator-service.ts`
    - `waitForWriteSlot` 改为 DB 队列 + 锁获取逻辑
    - 新增 `releaseWriteSlot`/`reconcileWriteSlotState`
    - 终态路径统一真实释放锁
- 验证结果（临时 DB：`/tmp/dashboard-four-item.db`）：
  - 队列表记录（摘要）：
    - 会话 A：`acquired -> released(reason=completed)`
    - 会话 B：`waiting -> acquired -> released(reason=completed)`
  - 锁表最终为空：`write_slot_locks = []`
  - 审计 `slot_event` 出现完整序列：`waiting/acquired/released`
  - 不再出现“伪 reviewer 排队”语义。

### 3) phase 幂等键

- 状态：`已完成`
- 代码变更：
  - `src/dashboard/server/db/schema.sql`
    - 新增 `phase_execution_attempts`
    - 约束：`UNIQUE(session_id, phase, attempt)`
  - `src/dashboard/server/services/orchestrator-service.ts`
    - 新增 `executePhaseWithIdempotency`
    - 新增 `claimPhaseExecution` / `finishPhaseExecution`
    - 启动恢复时收敛 `running` 记录
- 验证结果：
  - 运行后落库：
    - `session_id=... phase=applying attempt=1 status=completed`（两条会话均有）
  - 手工插入同键重复记录，数据库报错：
    - `UNIQUE constraint failed: phase_execution_attempts.session_id, phase_execution_attempts.phase, phase_execution_attempts.attempt`
  - 证明 DB 级幂等键已生效。

### 4) 文件契约补全

- 状态：`已完成`
- 代码变更：
  - `src/dashboard/server/services/codex-executor.ts`
    - 扩展输出契约与归一化，支持 `create/modify/delete/rename`
  - `src/dashboard/server/services/orchestrator-service.ts`
    - `buildChangeFiles` 与 `buildDiffText` 支持 `delete/rename`
  - `src/dashboard/server/services/git-service.ts`
    - `applyFiles` 支持四类操作
    - `captureWorkspaceSnapshot` 覆盖 rename 源/目标路径
  - `src/mcp-server-codex/src/codex-client.ts`
  - `src/mcp-server-codex/src/tools/submit-task.ts`
  - `src/mcp-server-codex/src/types.ts`
- 验证结果：
  - 成功场景（rename + delete + create）：
    - `old.txt` 不存在
    - `renamed.txt` 存在且内容 `new-content`
    - `delete.txt` 不存在
    - `created.txt` 存在且内容 `created`
    - 会话状态：`completed`
  - 回滚场景（批次内第二条 rename 非法）：
    - 报错：`Rename operation requires old_path: rollback-bad.txt`
    - `rollback-good.txt` 最终不存在（回滚成功）
    - 会话状态：`failed`
    - `change_sets.status = apply_failed`

### 5) 后续架构推进（控制面队列化 + 回归自动化）

- 状态：`已完成（本轮增量）`
- 代码变更：
  - `src/dashboard/server/db/schema.sql`
    - 新增 `session_dispatch_jobs`
  - `src/dashboard/server/services/orchestrator-service.ts`
    - 新增 `CONTROL_PLANE_MODE=direct|queue`
    - `queue` 模式下：接口触发只入队，后台 dispatcher 拉起 loop
    - 启动时恢复卡在 `running` 的 dispatch job
  - `src/dashboard/server/routes/system.ts`
    - 新增 `/api/control-plane`（模式、队列长度、active loops、provider）
  - `src/dashboard/.env.example`、`src/dashboard/README.md`
    - 新增 `CONTROL_PLANE_MODE` 配置说明
  - 新增自动化回归脚本：
    - `tests/architecture/verify-four-item-regression.mjs`
    - `tests/architecture/stress-restart-recovery.mjs`
    - `tests/architecture/README.md`
- 验证结果：
  - `node tests/architecture/verify-four-item-regression.mjs` 返回 `ok: true`
    - 校验通过：provider=mcp、control plane=queue、slot waiting 事件、写槽释放、phase 落库
  - `node tests/architecture/stress-restart-recovery.mjs` 返回 `ok: true`
    - 校验通过：dispatch `running` 恢复、stale write lock 回收
