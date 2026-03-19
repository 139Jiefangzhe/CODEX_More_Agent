# 茶贸项目西城区停车数据接入层

这个目录提供一个可安装、可迁移、可运维的西城区停车数据接入模块。

- Node.js 部分：负责把停车场静态信息和实时空位数据上报到西城区平台，主要用于联调和兼容现有 CLI。
- Python 部分：负责从 MySQL 的 `cp_order_trip_real_record` 表取数、逻辑池回放、迁移、健康检查和维护。

已确认的上报基础地址：

```text
https://datahub.renniting.cn/apis/v1
```

## 范围

- `PUT /parkings/{parking_id}`：初始化或更新停车场静态信息
- `POST /parkings/{parking_id}/operations`：上报实时空位、当日累计入场数、当日累计出场数
- 公共参数签名：`app_key/app_uuid/req_uuid/sig_method/timestamp/signature`
- 业务参数加密：AES-ECB + PKCS7 + Base64 特殊字符替换

不在本次范围内：

- 邦道系统如何读取总车位、剩余车位、当日入场/出场总数
- 车辆进出明细、收费、设备、出入口等其他接口
- 平台侧告警平台、短信/邮件通知集成

## 环境变量

复制 `.env.example` 后按真实值设置：

```text
# Westcity API
WESTCITY_BASE_URL=https://datahub.renniting.cn/apis/v1
WESTCITY_APP_KEY=你的appKey
WESTCITY_APP_SECRET=你的appSecret
WESTCITY_DATA_KEY=你的dataKey
WESTCITY_APP_UUID=tea-trade-parking-sync
WESTCITY_SIG_METHOD=HMAC-SHA1
WESTCITY_TIMEOUT_MS=5000
WESTCITY_TIMEOUT_SECONDS=
WESTCITY_RETRY_COUNT=1
WESTCITY_LOG_LEVEL=INFO

# Pool/reporting
WESTCITY_MAX_FREE_BERTH=268
WESTCITY_PHYSICAL_CAPACITY=420
WESTCITY_SOURCE_PARK_ID=本地数据库中的 park_id
WESTCITY_SOURCE_TABLE=cp_order_trip_real_record
WESTCITY_HIDDEN_AUTH_TYPES=monthly,internal
WESTCITY_POOL_BATCH_SIZE=200
WESTCITY_POOL_MAX_EVENTS=5000
WESTCITY_POOL_KEY_PREFIX=wc:pool
WESTCITY_POOL_COUNTER_TTL_SECONDS=7776000
WESTCITY_POOL_LOOKBACK_SECONDS=604800
WESTCITY_POOL_PUSH_REPLAY_LIMIT=20
WESTCITY_POOL_LOCK_TIMEOUT_SECONDS=1
WESTCITY_RETENTION_DAYS=30
WESTCITY_MAX_PUSH_AGE_SECONDS=600

# MySQL
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=数据库用户名
MYSQL_PASSWORD=数据库密码
MYSQL_DATABASE=数据库名
MYSQL_CHARSET=utf8mb4
MYSQL_TIMEZONE=Asia/Shanghai

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
REDIS_SSL=false
```

说明：

- `WESTCITY_APP_KEY`、`WESTCITY_APP_SECRET`、`WESTCITY_DATA_KEY` 必须使用真实平台分配值。
- `WESTCITY_APP_UUID` 建议固定为部署节点稳定标识。
- `WESTCITY_TIMEOUT_MS` 与 `WESTCITY_TIMEOUT_SECONDS` 只设置一个；都设置时必须保持一致。
- `WESTCITY_MAX_FREE_BERTH` 在逻辑池模式下代表对外报送容量（例如 268）。
- `WESTCITY_PHYSICAL_CAPACITY` 表示真实物理总车位（例如 400+）。
- `WESTCITY_HIDDEN_AUTH_TYPES` 用于定义 hidden-first 车辆类型，按 `auth_type` 逗号分隔。
- `MYSQL_TIMEZONE` 用于声明 MySQL `datetime` 的实际时区，默认 `Asia/Shanghai`。
- `WESTCITY_POOL_LOOKBACK_SECONDS` 用于补抓迟到/回填事件，默认回看 7 天。
- `WESTCITY_RETENTION_DAYS` 和 `WESTCITY_MAX_PUSH_AGE_SECONDS` 分别用于历史清理和健康检查。

## 使用方式

### 1. 代码调用

```js
import { createClientFromEnv } from "./src/index.js";

const client = createClientFromEnv();

await client.updateParkingStaticInfo({
  fullname: "茶贸停车场",
  type: 1,
  abbrname: "茶贸停车场",
  recordno: "XCP-2025-0001",
  lat: 39.91737,
  lng: 116.378828,
  street: 1,
  address: "北京市西城区茶贸街道 1 号",
  contact: "张三",
  phone: "13900000000",
  space: 300,
  dsspace: 2,
  bizspace: 260,
  nespace: 10,
  fastpile: 2,
  slowpile: 4,
  numexit: 1,
  numentry: 2,
  exspace: 20,
  smartlevel: 0,
  isname: "邦道停车",
  issn: "911000000000000001",
  muname: "茶贸停车管理有限公司",
  musn: "911000000000000002",
  ationname: "茶贸充电运营有限公司",
  updatetime: Math.floor(Date.now() / 1000)
});

await client.reportOperations({
  dotime: Math.floor(Date.now() / 1000),
  freeberth: 128,
  in: 560,
  out: 432
});
```

### 2. CLI 联调

准备 JSON 文件后执行：

```bash
npm run send:static -- --payload ./samples/static.json
npm run send:operations -- --payload ./samples/operations.json
```

CLI 从环境变量读取配置，不会把密钥写进命令参数。

如果当前目标只是“先把接口链路调通”，可以直接使用这两份已验证样例：

```bash
npm run send:static -- --payload ./samples/static-centurytea-final.json
npm run send:operations -- --payload ./samples/operations-centurytea-connectivity.json
```

说明：

- `static-centurytea-final.json` 是已经过真实平台校验并返回成功的静态样例。
- `operations-centurytea-connectivity.json` 只用于验证签名、加密、网关和业务校验链路，不代表生产统计口径。

### 3. Python 从 MySQL 取数并推送

先安装依赖。建议直接装成可执行包：

```bash
python3 -m pip install -e .
```

脚本会自动读取 `.env`：

- 优先读取当前执行目录下的 `.env`
- 当前目录没有时，再读取脚本所在目录下的 `.env`
- 如果当前 shell 已经存在同名环境变量，以当前 shell 为准，不会被 `.env` 覆盖

如果只安装运行时依赖，也可以保留：

```bash
python3 -m pip install -r requirements-python.txt
```

需要额外配置以下环境变量：

```text
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=数据库用户名
MYSQL_PASSWORD=数据库密码
MYSQL_DATABASE=数据库名
MYSQL_CHARSET=utf8mb4
MYSQL_TIMEZONE=Asia/Shanghai
```

建议先 dry-run 检查汇总结果：

```bash
python3 westcity_db_push.py --dry-run --as-of 2026-03-18T10:00:00+08:00
```

如果 `.env` 不在默认位置，也可以显式指定：

```bash
python3 westcity_db_push.py --env-file /path/to/.env --dry-run
```

确认结果无误后再正式推送：

```bash
python3 westcity_db_push.py --as-of 2026-03-18T10:00:00+08:00
```

Python 脚本会完成以下工作：

- 从 `cp_order_trip_real_record` 中统计指定 `park_id` 截止某一时刻的当日累计进场数 `in` 和出场数 `out`
- 通过未匹配出场的进场记录估算当前场内车辆数 `inside_count`
- 用 `WESTCITY_MAX_FREE_BERTH - inside_count` 计算 `freeberth`，并裁剪到 `0..总车位`
- 按西城区规则生成 `signature`、AES-ECB 密文和 `application/x-www-form-urlencoded` 请求体

注意：

- 这个 Python 脚本只实现 `POST /parkings/{parking_id}/operations`。
- 你给出的单表没有收费金额、支付状态、支付时间、车牌颜色等完整字段，所以本次不实现 `outorders` 明细推送，避免伪造业务数据。
- `freeberth` 依赖 `trip_id/order_id` 对进出场配对；如果你的系统存在空值或脏数据，建议后续改为直接读取业务系统的剩余车位表。
- 接口文档要求 `freeberth` 每 5 分钟上报一次、空位为 0 时立即上报，所以如果库里存在“当前车位状态表”或“实时空位汇总表”，应优先切换到真实空位来源，而不是长期依赖流水反推。
- 静态接口在真实联调中确认还需要 `ationname` 字段，含义为“充电设施运营单位”；如果缺失，平台会返回 400。

### 4. Python 逻辑名额池（正式生产口径）

`westcity_pool_sync.py` / `python -m westcity_sync.westcity_pool_sync` 用于 Redis + MySQL 双写模式下的“逻辑名额池”处理：

- MySQL 负责事件审计、分配台账、日计数、推送日志和检查点（事实源）
- Redis 负责实时计数缓存（report_inside/hidden_inside/in/out），写入与读取都使用事务化 pipeline
- 推送接口只使用 report 池口径，满足对外 `space=268` 的监管要求

先执行迁移：

```bash
python3 westcity_migrate.py --env-file /path/to/.env
```

建议先跑 dry-run：

```bash
python3 westcity_pool_sync.py --dry-run --allow-redis-down --as-of 2026-03-18T10:00:00+08:00
```

正式处理并推送：

```bash
python3 westcity_pool_sync.py --allow-redis-down --as-of 2026-03-18T10:00:00+08:00
```

关键参数：

- `--skip-push`：只处理事件和刷新快照，不发 HTTP
- `--batch-size`：覆盖单批拉取条数
- `--max-events`：覆盖单次最多处理事件数
- `--allow-redis-down`：Redis 不可用时自动回退 MySQL 快照模式
- 如果本次处理后还有历史 backlog，脚本会自动跳过推送，避免首次上线时推送半成品快照

### 5. Python 模拟数据测试推送

如果当前目标是“先不依赖真实 MySQL/Redis，直接验证 `operations` 推送链路”，可以用 `westcity_operations_simulator.py`：

- 生成一批假的进出场事件
- 按当前逻辑池规则计算最终 `freeberth / in / out`
- 默认只 dry-run，输出脱敏请求地址和模拟结果
- 只有显式加 `--push` 才会真的发起 HTTP 请求

先本地生成一份模拟结果：

```bash
python3 westcity_operations_simulator.py \
  --as-of 2026-03-18T10:00:00+08:00 \
  --car-count 180 \
  --duration-minutes 180 \
  --hidden-ratio 20 \
  --exit-rate 75 \
  --output ./artifacts/simulated-operations.json
```

常用参数：

- `--car-count`：生成多少个模拟会话
- `--duration-minutes`：把进场事件均匀打散到结束时刻之前的多少分钟内
- `--hidden-ratio`：多少比例的车辆按 hidden-first 处理
- `--exit-rate`：多少比例的车辆在 `as-of` 前完成出场
- `--seed`：固定随机种子，保证每次生成结果一致
- `--output`：把完整事件明细和快照写入 JSON 文件

如果 dry-run 结果符合预期，再做一次真实接口测试推送：

```bash
python3 westcity_operations_simulator.py \
  --as-of 2026-03-18T10:00:00+08:00 \
  --car-count 180 \
  --duration-minutes 180 \
  --hidden-ratio 20 \
  --exit-rate 75 \
  --push
```

说明：

- 这个模拟器不会写入真实业务数据库。
- 这个模拟器不会验证真实生产口径，只用于接口联通、自测和回归。
- 如果后续需要“把模拟数据灌入测试库再跑正式脚本”，可以在这个基础上再加 SQL 导出功能。

## 和邦道系统对接建议

因为当前工作区没有邦道停车系统源码，本模块采用“外部提供数据、内部完成上报”的方式。落地时只需要把邦道系统的字段映射到以下两类输入：

- 静态信息：首次初始化时提供停车场基础资料与总车位 `space`
- 实时空位：每 5 分钟提供一次 `freeberth`、`in`、`out`、`dotime`

建议映射关系：

- 邦道总车位 -> `space`
- 邦道实时剩余车位 -> `freeberth`
- 邦道当日累计入场数 -> `in`
- 邦道当日累计出场数 -> `out`
- 上报时间秒级时间戳 -> `dotime`

## 测试

```bash
npm test
python3 -m unittest discover -s python_tests -v
```

测试覆盖：

- 签名与 Base64 特殊字符转换
- AES 加密输出
- 静态接口请求构造
- 实时空位接口请求构造
- `parking_id = appKey` 约束
- `freeberth` 边界校验
- Python 签名、AES 加密、SQL 聚合与 dry-run 输出
- 逻辑池分配规则、会话ID解析与快照裁剪
- `process_source_event` 失败回滚补记、Redis pipeline、迟到事件回看、超容量保护

## 部署

建议在邦道服务器按下面顺序部署：

```bash
python3 -m pip install -e .
python3 westcity_migrate.py --env-file /opt/parking-westcity-sync/.env
python3 westcity_pool_sync.py --dry-run --allow-redis-down
python3 westcity_maintenance.py healthcheck --env-file /opt/parking-westcity-sync/.env --allow-redis-down
```

项目已提供 `ops/systemd/` 模板：

- `westcity-pool-sync.service` / `westcity-pool-sync.timer`：每 5 分钟跑一次同步
- `westcity-healthcheck.service` / `westcity-healthcheck.timer`：每 10 分钟做一次健康检查

历史清理：

```bash
python3 westcity_maintenance.py prune --env-file /path/to/.env --retain-days 30
```

## 注意事项

- 文档中基础地址示例曾出现 `/hub/apis/v1`，但本次按用户确认值 `https://datahub.renniting.cn/apis/v1` 实现。
- PDF 的个别静态字段 OCR 不够稳定，模块对明确字段做严格校验，其他字段会按调用方传入透传；如接口方提供更清晰字段表，建议再补齐映射。
- 错误对象会隐藏 query 中的 `signature`，避免在日志中泄露敏感签名结果。
- `westcity_pool_sync.py` 会在运行前申请 MySQL 锁，避免 cron / timer 并发重入。
- 失败推送会写入 `wc_pool_push_log`，后续运行会优先补推未成功的历史快照。
