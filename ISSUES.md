# parking-westcity-sync 问题清单

> 审查范围：全部源码、测试、SQL schema、配置文件
>
> 初始审查日期：2026-03-18
>
> 复查日期：2026-03-19（项目重构后）

---

## 目录

- [修复总览](#修复总览)
- [一、残留问题](#一残留问题)
- [二、新引入问题](#二新引入问题)
- [三、设计层面的已知限制](#三设计层面的已知限制)
- [附录 A：初始审查问题与修复对照表](#附录-a初始审查问题与修复对照表)

---

## 修复总览

初始审查共识别 **6 大类 41 项问题**。经 2026-03-19 重构后复查：

| 状态 | 数量 |
|------|------|
| ✅ 已完全修复 | 33 |
| ⚠️ 大幅改善（残留低风险边界条件） | 4 |
| ℹ️ 设计选择（未变，非 bug） | 4 |
| ❌ 未修复 | 1 |
| 🆕 新引入 | 3 |

**仍需处理的高危问题：1 项（残留-1）。**

---

## 一、残留问题

### 残留-1（高）MySQL 连接泄漏 — Redis 失败时 connection 未关闭

- **文件**：`westcity_sync/westcity_pool_sync.py:1088-1097`
- **原编号**：BUG-05
- **状态**：❌ 未修复
- **描述**：

```python
connection = connect_mysql(db_config)       # line 1088 — 连接已打开
redis_client = None
lock_acquired = False
try:
    redis_client = connect_redis(redis_config)  # line 1093
except Exception as exc:
    if not args.allow_redis_down:
        raise                                   # line 1096 — 跳到外层 except
    redis_warning = str(exc)

try:                                            # line 1099
    ...
finally:
    ...
    connection.close()                          # line 1273 — 不会执行
```

当 Redis 连接失败且 `--allow-redis-down` 未设置时，`raise` 在 line 1096 跳到外层 `except`（line 1274 或 1277），内层 `try...finally`（line 1099-1273）中的 `connection.close()` 不会执行。MySQL 连接泄漏。

- **修复建议**：将 `connection` 的生命周期管理提到与 `connect_mysql` 同层，例如：

```python
connection = connect_mysql(db_config)
try:
    redis_client = None
    try:
        redis_client = connect_redis(redis_config)
    except Exception as exc:
        if not args.allow_redis_down:
            raise
        redis_warning = str(exc)

    # ... event processing ...
finally:
    connection.close()
```

---

### 残留-2（低）`inside_sql` 和 `resolve_session_id` 在 plate 为空时仍有匹配盲区

- **文件**：`westcity_sync/westcity_db_push.py:428-438`、`westcity_sync/westcity_pool_sync.py:125-138`
- **原编号**：BUG-03 / BUG-04
- **状态**：⚠️ 大幅改善，残留低风险边界
- **描述**：plate 提升为最高优先匹配维度后绝大多数场景已修复。但当 **plate 为空**且入场/出场使用不同 ID 类型时（入场只有 trip_id，出场只有 order_id），两条路径仍无法匹配：
  - `inside_sql`：三个 OR 分支都不命中 → 入场永久计为场内
  - `resolve_session_id`：入场 `trip:T100`，出场 `order:O200` → orphan_exit
- **实际风险**：低。停车场系统通常记录车牌，且同一停车会话的 trip_id/order_id 通常一致。仅在源数据异常且无车牌时触发。

---

### 残留-3（低）`persist_failed_event` 自身异常仍可中断批次

- **文件**：`westcity_sync/westcity_pool_sync.py:756-760`
- **原编号**：LOGIC-05 的边界情况
- **状态**：⚠️ 主流程已修复，残留极端边界
- **描述**：

```python
except Exception as exc:
    connection.rollback()
    LOGGER.exception(...)
    persist_failed_event(connection, park_id, event, str(exc))  # ← 如果这里也抛异常？
    return "failed", None
```

如果 `persist_failed_event` 本身也失败（如 MySQL 连接彻底断开），异常传播到 `main()` 的事件循环（line 1140 无 try/except），导致进程退出。

- **实际风险**：很低。`rollback()` 后连接通常仍可用，`persist_failed_event` 失败意味着数据库本身已不可达，此时退出是合理行为。

---

### 残留-4（低）首次运行无初始状态引导

- **原编号**：RUNTIME-03
- **状态**：⚠️ 部分缓解
- **描述**：`ensure_runtime_rows` 仍将新 park_id 初始化为 `report_inside=0, hidden_inside=0`。但新增的 `reconcile_runtime_state` 每次运行后从 allocation 表反算校准，防止了长期漂移。首次运行期间（追赶历史事件完成前），backlog 未清完时跳过推送（`backlog-incomplete`），避免了推送错误数据。
- **实际风险**：低。backlog 检测 + 校准机制组合后，首次运行不再推送错误数据。

---

## 二、新引入问题

### 新引入-1（低）`fetch_source_events` 的 CAST JOIN 可能阻止索引使用

- **文件**：`westcity_sync/westcity_pool_sync.py:396-397`
- **描述**：

```sql
LEFT JOIN wc_pool_event_log AS log
  ON log.park_id = src.park_id
 AND log.source_event_id = CAST(src.pk_trip_real_id AS CHAR)
```

`CAST(src.pk_trip_real_id AS CHAR)` 导致 MySQL 在 JOIN 时对源表每行做类型转换，可能无法利用 `idx_park_source_event(park_id, source_event_id)` 索引进行等值匹配，退化为逐行扫描 event_log。在 lookback 窗口内数据量大时可能产生性能问题。

- **建议**：确认 MySQL 执行计划（`EXPLAIN`），如有性能问题可考虑在源表侧预转换或在 event_log 侧存储整数类型的 source_event_id。

---

### 新引入-2（低）`reconcile_runtime_state` 每次运行都全量扫描 allocation 表

- **文件**：`westcity_sync/westcity_pool_sync.py:763-812`，调用于 line 1158
- **描述**：无论是否处理了新事件（`processed_total` 可能为 0），`reconcile_runtime_state` 都执行一次全表 `SUM(CASE...)` 聚合。随着 allocation 表增长（即使有定期清理），每次运行的聚合成本逐渐增加。
- **建议**：可根据 `processed_total > 0` 条件决定是否执行校准，或通过 `idx_park_status_pool` 索引限定扫描范围（仅聚合 `status='inside'` 的行）。

---

### 新引入-3（低）`replay_failed_pushes` 构建的 PoolSnapshot 含占位值

- **文件**：`westcity_sync/westcity_pool_sync.py:1009-1017`
- **描述**：

```python
snapshot = PoolSnapshot(
    dotime=int(payload["dotime"]),
    counter_day=datetime.fromtimestamp(int(payload["dotime"])).strftime("%Y%m%d"),
    report_inside=0,    # ← 占位值
    hidden_inside=0,    # ← 占位值
    ...
)
```

`report_inside=0` 和 `hidden_inside=0` 是占位值。该 snapshot 仅用于 `log_push_result` 中记录 `dotime`，不影响实际推送数据。但 push_log 中记录的 snapshot 信息不完整，对审计和排查有一定干扰。

此外 `datetime.fromtimestamp()` 未指定时区，使用系统本地时区，如果系统时区非 Asia/Shanghai，`counter_day` 可能偏差一天。

---

## 三、设计层面的已知限制

以下问题在两轮审查中识别，属于架构设计选择而非代码缺陷，记录于此供团队评估。

### DESIGN-01 双语言重复实现

- **原编号**：ARCH-01
- **现状**：Node.js（`src/`）与 Python（`westcity_sync/`）各自实现了签名、加密、HTTP 推送。Python 侧功能完全覆盖 Node.js。维护两套代码的成本较高。

### DESIGN-02 两条推送路径的 in/out/freeberth 语义不同

- **原编号**：LOGIC-07
- **现状**：db_push 统计全部车辆，pool_sync 仅统计 report 池。两个路径对 `in`/`out`/`freeberth` 的定义不一致。如果平台只使用一条路径则无影响，但路径切换时数据会断裂。

### DESIGN-03 hidden 池对平台不可见

- **原编号**：RUNTIME-07 / RUNTIME-08
- **现状**：hidden 池车辆的入场/出场不计入推送的 `in`/`out`，平台无法做 `freeberth + in - out` 连续性校验。午夜 daily counter 归零也导致连续性断裂。这是逻辑名额池设计的固有特征。

### DESIGN-04 强耦合源表

- **原编号**：ARCH-03
- **现状**：直接查询 `cp_order_trip_real_record`，依赖 11 个字段名。源系统表结构变更会导致同步中断。

---

## 附录 A：初始审查问题与修复对照表

### A.1 代码 Bug（初始 9 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| BUG-01 | 异常处理写入已回滚行 | ✅ 已修 | `persist_failed_event` 独立事务 + `INSERT ... ON DUPLICATE KEY UPDATE` |
| BUG-02 | inside_sql 无标识记录永久计内 | ✅ 已修 | 新增 `COALESCE(NULLIF(TRIM(plate),...))` 过滤 + plate 匹配分支 |
| BUG-03 | inside_sql 跨 ID 类型匹配失败 | ⚠️ 改善 | plate 作为首选匹配分支，plate 为空时仍有理论边界（残留-2） |
| BUG-04 | resolve_session_id 不对称 | ⚠️ 改善 | plate 提升为最高优先级，plate 为空时仍有理论边界（残留-2） |
| BUG-05 | MySQL 连接泄漏 (Redis 失败) | ❌ **未修** | 代码结构未变，仍存在（残留-1） |
| BUG-06 | cryptography 依赖缺失 | ✅ 已修 | `cryptography==46.0.5` 添加到 requirements |
| BUG-07 | parse_bool("") 崩溃 | ✅ 已修 | 空字符串返回 default |
| BUG-08 | db_push.main() 未兜底异常 | ✅ 已修 | 新增 `except Exception` + `LOGGER.exception` |
| BUG-09 | hydrate_environment({}) 回退 | ✅ 已修 | `is None` 判断替换 `or` |

### A.2 逻辑缺陷（初始 14 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| LOGIC-01 | Redis 写入非原子 | ✅ 已修 | `pipeline(transaction=True)` |
| LOGIC-02 | Redis inside 键无 TTL | ✅ 已修 | 统一使用 `setex` |
| LOGIC-03 | Redis dedup 键从未读取 | ✅ 已修 | 整体移除 |
| LOGIC-04 | choose_pool 超容量分配 | ✅ 已修 | 满时返回 `None`，标记 `overflow_entry` |
| LOGIC-05 | 单事件异常杀死整批 | ✅ 已修 | 捕获异常返回 `"failed"` + 独立持久化（残留-3 为极端边界） |
| LOGIC-06 | count_sql/inside_sql 口径差异 | ℹ️ 设计如此 | `in`/`out` 为日计数，`inside` 为累计，合理 |
| LOGIC-07 | 两路径 in/out 语义不同 | ℹ️ 设计选择 | 见 DESIGN-02 |
| LOGIC-08 | pool_state 计数漂移 | ✅ 已修 | `reconcile_runtime_state` 从 allocation 表反算 |
| LOGIC-09 | timestamp=0 静默替换 | ✅ 已修 | `is None` 判断 |
| LOGIC-10 | 超时精度丢失 | ✅ 已修 | `float` 除法 + 冲突检测 |
| LOGIC-11 | 重试复用签名 timestamp | ✅ 已修 | 循环内重建 URL（Python + Node.js） |
| LOGIC-12 | hidden 事件空写 daily_counter | ✅ 已修 | `if in_inc == 0 and out_inc == 0: return` |
| LOGIC-13 | event_log 冗余 UNIQUE KEY | ✅ 已修 | 改为普通 KEY |
| LOGIC-14 | 容量缩小不校验 inside | ✅ 已修 | `FOR UPDATE` 读取 + 超限拒绝启动 |

### A.3 架构问题（初始 5 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| ARCH-01 | 双语言重复 | ℹ️ 设计选择 | 见 DESIGN-01 |
| ARCH-02 | Python 无包结构 | ✅ 已修 | `westcity_sync/` 包 + `__init__.py` + 相对导入 |
| ARCH-03 | 强耦合源表 | ℹ️ 设计选择 | 见 DESIGN-04 |
| ARCH-04 | 单 .env 混合配置 | ⚠️ 改善 | 分组注释、新增 MYSQL_TIMEZONE / LOG_LEVEL 等 |
| ARCH-05 | 超时二义性 | ✅ 已修 | 两侧都支持 MS/Seconds + 冲突检测 |

### A.4 运行时陷阱（初始 10 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| RUNTIME-01 | checkpoint 对回填数据失明 | ✅ 已修 | LEFT JOIN event_log + lookback 窗口（默认 7 天） |
| RUNTIME-02 | orphan_exit 与迟到入场 | ✅ 已修 | `reconciled_late_pair` 逻辑 |
| RUNTIME-03 | 无初始状态引导 | ⚠️ 缓解 | `reconcile_runtime_state` 校准 + backlog 跳过推送（残留-4） |
| RUNTIME-04 | 无并发保护 | ✅ 已修 | MySQL `GET_LOCK` / `RELEASE_LOCK` |
| RUNTIME-05 | 时区假设 | ✅ 已修 | `MYSQL_TIMEZONE` + `to_mysql_naive` |
| RUNTIME-06 | 推送失败无补推 | ✅ 已修 | `replay_failed_pushes` |
| RUNTIME-07 | hidden 池平台校验 | ℹ️ 设计如此 | 见 DESIGN-03 |
| RUNTIME-08 | 午夜 counter 归零 | ℹ️ 设计如此 | 见 DESIGN-03 |
| RUNTIME-09 | dotime 与推送脱节 | ⚠️ 缓解 | backlog 未清完时跳过推送 |
| RUNTIME-10 | 同秒事件顺序错误 | ✅ 已修 | `ORDER BY ... CASE WHEN type='00' THEN 0 ...` 入场优先 |

### A.5 测试缺陷（初始 4 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| TEST-01 | 加密未交叉验证 | 待确认 | 需检查测试代码是否更新密钥 |
| TEST-02 | process_source_event 零覆盖 | ⚠️ 改善 | 新增 failure / overflow 测试，完整路径覆盖仍有限 |
| TEST-03 | Redis 交互零覆盖 | ⚠️ 改善 | 新增 pipeline + fallback 测试 |
| TEST-04 | 无集成测试 | — 未变 | |

### A.6 工程化缺失（初始 6 项）

| 原编号 | 问题 | 修复状态 | 修复方式 |
|--------|------|----------|----------|
| ENG-01 | 无版本控制 | 待确认 | |
| ENG-02 | 无迁移机制 | ✅ 已修 | `migrate.py` + `wc_schema_migrations` 表 + checksum 校验 |
| ENG-03 | 审计表无限增长 | ✅ 已修 | `maintenance.py prune` + `WESTCITY_RETENTION_DAYS` |
| ENG-04 | 无日志框架 | ✅ 已修 | `logging_utils.py` + `WESTCITY_LOG_LEVEL` |
| ENG-05 | 无健康检查 | ✅ 已修 | `maintenance.py healthcheck` + push_lag 检测 |
| ENG-06 | connect_mysql 行为不一致 | ✅ 已修 | 统一为单函数 + `autocommit` 参数 |
