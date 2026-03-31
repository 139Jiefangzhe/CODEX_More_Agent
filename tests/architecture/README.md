# 架构回归脚本

## 1. 四项回归（provider/写槽/幂等/文件契约）

```bash
node /data/claude_moreagent/tests/architecture/verify-four-item-regression.mjs
```

覆盖点：

- `CODEX_PROVIDER=mcp` 执行路径验证
- `CONTROL_PLANE_MODE=queue` 控制面队列模式验证
- `write_slot_queue/write_slot_locks` 排队与释放验证
- `phase_execution_attempts` 幂等落库验证

## 2. 重启恢复压力（dispatch + stale lock）

```bash
node /data/claude_moreagent/tests/architecture/stress-restart-recovery.mjs
```

覆盖点：

- `session_dispatch_jobs` 的 `running -> queued/done` 恢复
- `write_slot_locks` stale 锁回收
