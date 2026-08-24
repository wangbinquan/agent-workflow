# RFC-322 维护节奏错峰与停顿归因 —— proposal

## 1. 背景

生产环境（发布包启动，非开发态）反复出现「每隔一段时间全站冻结约 30 秒、随后自行恢复」，
伴随 `[db-slow]` 打出 30 秒级的语句：

```
[db-slow] 32648ms: select "id", "workspace_pruning_at" from "tasks" where (…)
[db-slow]  1220ms: select "id", "worktree_path", … from "tasks" where (…)
[db-slow]  1232ms: select "id", "attempt_count" from "webhook_deliveries" where (…)
```

同库实测该 SQL 走索引 `idx_tasks_status_workgroup`、耗时 **10ms**，`tasks` 表 346 行 / 3MB；
外部进程以 1Hz 打同一条 SQL 连测 14 分钟，**零次超过 300ms**。
即：**报出来的 32 秒不是查询代价，是 daemon 线程被占住 32 秒**，慢查询日志把整段停顿
栽赃给了当时正在执行的那条语句。

停顿的成因是两个结构性事实叠加：

1. **daemon 只有一条 bun:sqlite 同步连接**，每条 SQL 同步独占事件循环。
   `db/client.ts:50-53` 自述："Every statement here runs synchronously on the daemon's
   event loop, so a slow one freezes ALL HTTP/WS — surface them."
2. **约 12 个 hourly 维护定时器在 boot 的同一秒内装配、且零抖动**
   （`cli/start.ts:885–1376`；在 `gc.ts` / `eventsArchive.ts` / `maintenanceRetention.ts` /
   `daemonCadence.ts` / `start.ts` 上 grep `jitter|Math.random()` 结果为空）。
   于是每小时的同一秒，它们在同一个 event-loop 窗口里首尾相接地执行。

其中最重的一拍是 `gc.ts:815-826`：`startWorktreeGc` 单拍串跑 6 段遍历文件系统的 GC
（webhook prune → worktree GC → iso GC → scratch orphan GC → worktree orphan GC →
partial clone GC）。用户贴出的前两条慢语句正是这条链的第 1、2 段，顺序完全吻合。

配套的第二个问题是**归因不能**：现在没有任何一处记录「某个维护任务这一拍跑了多久」，
`[db-slow]` 又只量语句墙钟。运维看到 30 秒只能猜，本次定位耗费了大量往返才排除
「查询慢 / 索引缺失 / 库太大 / 磁盘慢」四个错误方向。

## 2. 目标

- **G1 错峰**：同周期的维护任务在周期内均匀铺开，稳态下任一时刻至多一个重维护任务在跑。
- **G2 可归因**：每个维护任务每拍的实际耗时可观测；超过阈值主动告警，带任务名。
- **G3 停顿可判别**：`[db-slow]` 能区分「这条 SQL 真的在干活」与「进程被冻住了」。

## 3. 非目标

- 不改各维护任务自身的算法、批量策略或保留期语义（纯调度与观测层）。
- 不拆 `gc.ts` 那条 6 段链的内部结构（错峰后它独占自己的相位窗口；真要再拆另立 RFC）。
- 不把 `util/process.ts` 的同步 `Bun.spawnSync(['ps',…])` 改成异步（另立）。
- 不引入 worker 线程化 SQLite、不改 PRAGMA、不动 WAL checkpoint 策略。
- 不修 `ensureCredentialsSealed` 的 `maintenance_state` 闸门漏接（见 §6，另立）。

## 4. 用户故事

- 作为运维，daemon 连跑数天时不再出现整点的全站 30 秒冻结。
- 作为运维，当某个维护任务确实变慢，我能在日志里直接看到是**哪一个**、跑了多久，
  而不是看到一条无辜的 SELECT 被标成 32 秒。
- 作为开发者，新增一个周期性维护任务时，有一个明确的地方登记它的周期与相位，
  且忘记登记会被测试拦下。

## 5. 行为影响清单

本 RFC 不关闭任何既有能力，但改变了维护任务的**执行时刻**，逐条列出：

| 变化                                                                                                                                             | 影响                                     | 判断                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| hourly 任务首个周期拍从 `T0+1h` 改为 `T0+相位偏移`（4–48 分钟）                                                                                  | 各任务首次执行比原来**更早**，不会更晚   | 无害；体积封顶类任务本就希望早跑                                           |
| 各任务之间不再同刻触发                                                                                                                           | 单个任务的执行时刻在小时内平移           | 保留期/阈值语义均为「超过 N 天/N 行」，与执行时刻无关                      |
| 既有 `MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS`（30s boot 首拍）保持不变                                                                             | 无                                       | 显式保留，不与相位混用                                                     |
| 新增 slow-tick 告警日志                                                                                                                          | 稳态下不产生日志（阈值之下静默）         | 仅超阈时一行 warn                                                          |
| `startWorktreeGc` / `startBatchImportGc` 的定时器由「无 `unref()`」改为统一 `unref()`                                                            | 这两个循环不再单独把进程吊活着           | 有意；daemon 寿命由 HTTP server 与 shutdown 路径决定，其余 12 个本就 unref |
| `intentGcTimer` / `tokenAuditGcTimer` 补进关停路径                                                                                               | 此前只 `unref()`、从未被 `clearInterval` | 修正既有遗漏，收编成 ticker 后顺手补 `stop()`                              |
| `webhookGc.ts` / `repoBatchImport.ts` 的模块私有 `HOUR_MS`、`pluginGenerationGc.ts` 的 `DEFAULT_INTERVAL_MS` 删除，改用 `daemonCadence` 唯一来源 | 数值不变                                 | `daemonCadence.ts` 头部注释点名的「外挂周期」，本 RFC 收编                 |
| `[db-slow]` 行增加 CPU 时间字段                                                                                                                  | 日志格式变化                             | 该行是诊断日志，无消费方                                                   |

## 6. 顺带发现（不在本 RFC 范围，登记备查）

`db/schema.ts:6611` 声称 `maintenance_state` 承载
「`repoCredentials.ensureCredentialsSealed` 的「已完成」闸门（原实现每次 boot 和每次
`POST /api/backup` 都整库重扫做幂等迁移）」，但 `services/repoCredentials.ts` 全文
**没有任何 `maintenanceState` 引用**——该闸门从未接上，整库重扫至今每次 boot 都在跑。
注：其后的 `VACUUM` 有 `if (result.sealed > 0 || result.scrubbed > 0)` 守卫
（`repoCredentials.ts:409`），稳态安装 boot 不会 VACUUM；重扫本身才是那份未兑现的优化。
建议单独立 RFC 处理，本 RFC 不动它。

## 7. 验收标准

- **AC-1** `MAINTENANCE_PHASE` 注册表存在，覆盖全部 hourly 维护任务；每项满足
  `0 < offset < intervalMs`，且两两互异。
- **AC-2** 存在守卫测试：新增 hourly ticker 若未登记相位，测试转红。
- **AC-3** 用注入时钟/定时器驱动，能证明：在一个 `intervalMs` 窗口内，任意两个维护任务
  的触发时刻不重合。
- **AC-4** 每个维护任务每拍产出耗时度量；超过 `MAINTENANCE_SLOW_TICK_MS` 时 warn 一行，
  含任务名与耗时。有对应测试。
- **AC-5** `[db-slow]` 行含 CPU 时间；构造「墙钟远大于 CPU 时间」的场景时可据此判别。
  有对应单测（注入日志 sink）。
- **AC-6** 各 ticker 原有的错误日志文案、`stop()` 语义、`unref()` 行为、boot 首拍语义
  全部不变；既有测试（`rfc284-daemon-cadence` / `rfc311-maintenance-boot-tick` /
  `lifecycle-shutdown` / `rfc213-backup-retention` / `rfc244-alert-resolved-boot-wiring`）
  保持绿。
