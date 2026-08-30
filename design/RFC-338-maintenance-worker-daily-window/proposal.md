# RFC-338 — 重维护 Worker 隔离与每日维护时刻

- 状态：Done（2026-08-30；实现已发布，final exact-SHA hosted closeout 全绿）
- 发起：用户，2026-08-28
- source pin：`251b5d725ef731d15c17a01656fdc827f925e7c7`
- 前置：RFC-311（数据库性能与可扩展性）、RFC-322（小时维护错峰）、RFC-294（后台目标架构）

## 0. 终态一句话

数据库归档、保留期删除、worktree/上传目录回收和 WAL checkpoint 等同步重维护不再占用 HTTP/WS 的主事件循环；
管理员可在设置页选择“每小时错峰”或“每天 `HH:MM + IANA 时区` 启动一次”，而正确性恢复仍按原频率运行但同样在
后台 Worker 执行。这样从执行面消除“自动清理时界面长时间不响应”，并为后续 PostgreSQL/多实例迁移建立可替换边界。

## 1. 当前实现与根因

### 1.1 卡死不是“每小时”本身，而是重工作跑错了执行面

当前 `packages/backend/src/db/client.ts` 明确只有一条长期存在的 `bun:sqlite` 同步连接；任一慢 SQL 都会阻塞 daemon
事件循环，因此同一进程内的 HTTP、WebSocket 和其他 timer 都无法被调度。与此同时，小时维护中还存在同步文件系统工作：

- `eventsArchive.ts` 在循环中批量查询/删除并 `appendFileSync`；
- `maintenanceRetention.ts`、`webhook/deliveryStore.ts` 会循环删除直到本轮完成；
- `taskArchive.ts` 在数据库事务与 JSONL 文件输出间完成整树归档；
- `gc.ts#startWorktreeGc` 一拍串行执行 6 类恢复/目录扫描/删除，部分路径使用 `rmSync({ recursive: true })`；
- `backupScheduler.ts#checkpointWal` 在主连接同步执行 `wal_checkpoint(TRUNCATE)`，源码已记录它曾阻塞满 5 秒；
- `await` 包裹同步 Drizzle/SQLite 调用不会把 SQL 移出事件循环，也不会让一个同步 statement 可抢占。

因此，把频率从每小时改成每天只能把卡死搬到夜间，不能从根上解决；真正的根因是“面向请求的事件循环”和“同步
数据库/文件系统维护”共用同一线程。

### 1.2 RFC-322 已降低碰撞，但没有提供隔离

`daemonCadence.ts#MAINTENANCE_PHASE` 目前登记 14 个小时任务，以 4～56 分钟的固定相位错开；
`maintenanceTicker.ts` 也会记录超过 1 秒的 slow tick。这解决了 14 拍同秒首尾相接的问题，却仍由主事件循环直接调用
每个 `onTick`。任意单拍只要慢 2 秒，页面仍至少冻结 2 秒；多个任务实际重叠时仍会叠加。

RFC-311 已用 `backupVacuumWorker.ts` 证明 Worker 方向可行：只读 `VACUUM INTO` 从主同步连接移到独立 Worker/连接后，
原先 30～90 秒的全站冻结不再占用主事件循环。但 RFC-311 明确没有把普通查询、清理写入或第二连接纳入范围，
所以该先例没有覆盖其余维护任务。

### 1.3 直接“换 PostgreSQL”不是一个可安全一次替换的小改动

source pin 上的生产源码约有 303 个文件提及 `DbClient`、81 个文件使用 `dbTxSync`、29 个文件直接提及
`bun:sqlite`，258 个文件直接导入 `@/db/schema`。同时，`cli/start.ts` 仍采用单实例锁，任务 worktree、归档和日志仍是
本机文件系统事实。

所以本 RFC 只对“维护导致的卡死”做根因级修复，并把维护能力收进 port/adapter/Worker 边界；它不把单机 SQLite
描述成已经具备水平扩展能力。面向大量并发用户的 PostgreSQL、异步连接池、无状态 API/control plane 与 execution
worker 拆分必须作为后续独立 RFC，基于真实负载门分波迁移。

## 2. 工作分类

不能把全部小时任务机械地移到每天一次。目标分类如下：

| 类别           | 当前工作                                                                                                                                                                                                                                  | 目标节奏                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 重清理         | proactive worktree/iso/scratch/orphan/partial-clone GC、webhook delivery GC、events archive、retention sweep、task archive、backup prune、plugin generation GC、development upload/retention、employee input、intent scratch、token audit | 受新的“每小时错峰 / 每日固定时刻”配置控制，统一经 Worker 串行切片 |
| 正确性/恢复    | 已 claim workspace 清理恢复、intent apply/resource-bundle journal 收敛、queued working-set 恢复、lifecycle invariants、human-gate recovery                                                                                                | 保持现有 boot/周期语义；不等待每日窗口，但工作体移出主事件循环    |
| 轻量进程内     | `repoBatchImport` 的内存 `Map` TTL 回收等不访问 SQLite/磁盘的微小工作                                                                                                                                                                     | 留在主进程，不为“统一”支付 IPC 成本                               |
| 数据库内部维护 | 周期 WAL checkpoint/optimize 类工作                                                                                                                                                                                                       | 保持自己的功能节奏，但改由维护 Worker 的独立连接执行              |

其中 `intentGcTimer` 当前把 scratch 清理与三条恢复链混在同一 tick，`startWorktreeGc` 也把 durable recovery 与
proactive GC 串在同一 promise chain；实现前必须先按上表拆开，不能把恢复能力一起延迟到夜间。

## 3. 目标

1. 所有可能长时间执行的周期性 SQLite/文件系统维护都不在 HTTP/WS 主事件循环运行。
2. 新增可热更新的重维护日程：保留“每小时错峰”，并支持每天指定 `HH:MM` 与 IANA 时区启动一次。
3. 每个数据库写批次使用短事务、有限批量和协作式让步；维护连接遇到 foreground writer 时快速退让，而不是长时间占锁。
4. 同一重维护 job 不重入、不同重维护 job 不并行争用 SQLite writer；崩溃/重启后可识别并恢复未完成切片。
5. 设置页显示当前模式、时区、下一次计划时间、当前/最近一次执行、进度和失败，不再只能从日志猜测。
6. 保持现有保留期、归档、工作区 claim/fence、恢复与清理结果语义；只改变执行位置、调度方式和可观测性。
7. 建立 RFC-294 对齐的 background/persistence ports，使未来 PostgreSQL adapter 能替换存储实现，而不是继续增加
   `services/*` 对全局 `DbClient` 的直接耦合。
8. 用真实并发 HTTP/WS + 大库维护负载证明“维护期间仍响应”，而不是只用顺序 `app.request()` benchmark 证明单条 SQL 变快。

## 4. 非目标

- 本 RFC 不把业务数据库替换为 PostgreSQL，不开放多 daemon 同库写入，也不宣称完成水平扩展。
- 不把所有普通请求查询移到 query Worker/read pool；非维护路径自身的慢同步 SQL 留给后续 persistence RFC。
- 不改变任何数据保留天数、归档是否启用、worktree GC 判定或任务生命周期结果。
- 不把正确性恢复降频到每天一次，也不以“夜间”假设替代显式时区。
- 不新增任意 cron 表达式；产品只提供本问题需要的每小时与每日固定时刻。
- 不并行跑多个 SQLite 写维护任务；Worker 隔离解决主线程阻塞，不改变 SQLite 单 writer 事实。
- 不以本 RFC 领取 RFC-294 的 PostgreSQL/全仓 persistence cutover 完成状态。
- 不引入或调整权限、安全、凭据策略。

## 5. 待用户确认的裁决

批准本 RFC 即确认：

| ID  | 裁决                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 根因修复采用“主进程协调器 + 独立维护 Worker + Worker 自有 SQLite 连接”；主线程只做计时、IPC、轻量状态投影和广播。                                                 |
| D2  | `maintenanceSchedule` 支持 `{kind:'hourly'}` 与 `{kind:'daily', at:'HH:MM', timezone:'IANA'}`；存量默认仍为 hourly，升级不静默改变清理频率。                      |
| D3  | daily 表示“在该墙钟时刻启动一次维护 cycle”，不是强制结束时刻；大 backlog 可能越过该时刻继续低优先级切片，设置页必须如实显示。                                     |
| D4  | 重清理受 D2 控制；正确性/恢复保持原 boot/周期节奏但也送入 Worker；纯内存小 GC 留在主进程。混合 tick 必须拆分。                                                    |
| D5  | Worker 内重维护严格串行；每个 job 实现可恢复 `runSlice`，短事务/有限行数后让步，`SQLITE_BUSY` 快速退避，不在事务内做慢文件 I/O。                                  |
| D6  | 同一 schedule slot/job 只建立一条 durable run；重启、Worker crash、重复 timer 和错过多个 slot 都只合并成一个可恢复 pending/catch-up，不回放一串历史小时/日期。    |
| D7  | 保存新日程后立即重算“下一次”；已经开始的 cycle 不被中断或改写，新的配置从下一个 slot 生效。DST gap 取跳变后的首个有效瞬间，overlap 每个墙钟日只运行一次。         |
| D8  | worktree/上传等删除继续使用现有 durable claim/fence 作为最终依据；主进程活跃快照只能作为提示，Worker 在物理删除前必须重新验证 durable 状态。                      |
| D9  | 设置页新增“后台维护”卡，提供 hourly/daily、时间、时区与 last/current/next/backlog/error 状态；不要求管理员阅读 daemon 日志判断是否生效。                          |
| D10 | RFC-338 只可声明“根除周期维护占用 API 事件循环”；在 PostgreSQL + persistence port + 多实例负载门完成前，不得声明平台已经水平扩展。                                |
| D11 | 交付必须包含并发 HTTP/WS、foreground write、Worker crash、DST、热更新、missed-slot、active-task race 与大 backlog 的自动化证据；只跑现有顺序 benchmark 不算通过。 |

## 6. 用户可感知行为

### 6.1 设置

“设置 → 存储与保留”增加“后台维护”卡：

- 默认显示“每小时错峰（兼容现有行为）”；
- 切到“每天一次”后必须填写 24 小时制 `HH:MM`，时区默认带入浏览器 IANA 时区但可修改；
- 保存成功后显示按该时区格式化的“下次启动”；非法时间或无效 IANA 时区在字段旁直接报错；
- 正在执行时显示 cycle 开始时间、当前 job、已处理量和是否还有 backlog；完成/失败显示最近结果；
- 更改日程不会让正在运行的清理突然停在半个事务或半个目录删除中。

例如设置 `{kind:'daily', at:'03:00', timezone:'Asia/Shanghai'}` 后，重清理每天上海墙钟 03:00 启动一次；
正确性恢复和 WAL 自身维护节奏不等待 03:00。

### 6.2 运行时体验

- maintenance Worker 即使同步工作数秒，页面请求和 WebSocket 心跳仍由主事件循环正常处理；
- 如果维护与前台同时争写 SQLite，维护切片快速退让并稍后重试，前台写不会被一个大清理事务长期压住；
- backlog 很大时可能需要多个切片甚至跨过计划时刻继续处理，但用户能看到进度，且界面不因这项工作失去响应；
- Worker 崩溃只让当前切片回滚/重试，不结束 daemon，也不产生两个同 job 并发执行者。

## 7. 能力影响清单

| 能力           | 当前                              | RFC-338 后                                             |
| -------------- | --------------------------------- | ------------------------------------------------------ |
| 重维护默认频率 | 14 个小时任务按 boot 相位触发     | 存量仍 hourly；可配置 daily wall-clock                 |
| UI 响应        | 同步 SQL/FS 单拍会冻结 HTTP/WS    | 重工作在 Worker；主事件循环只做轻量协调                |
| SQLite writer  | 主连接单 writer 语义              | 仍是单 writer；维护独立连接以短事务和退避竞争          |
| 保留/归档结果  | 各模块现有规则                    | 规则不变；daily 模式下最迟发现时间可从约 1h 增至约 24h |
| 正确性恢复     | 部分与清理同 tick                 | 从清理拆开，原节奏不变，Worker 执行                    |
| checkpoint     | 主连接同步执行                    | Worker 连接执行，节奏与 snapshot 跳拍语义不变          |
| 配置生效       | 各 ticker 热读，调度相对 boot     | config listener 热应用；daily 按 IANA 墙钟计算         |
| 故障恢复       | 进程内 `running` 布尔值，不跨重启 | durable run/slot/lease/cursor，重复触发合并            |
| 可观测性       | slow-tick 日志为主                | 设置页 + 状态 API + 结构化 metrics/log                 |
| 多实例扩展     | 单实例 SQLite/本地 FS             | 不变；只建立后续替换所需边界                           |

## 8. 验收标准

- **AC-1 主线程隔离**：测试 Worker 内连续执行至少 2 秒同步 SQLite/FS 工作时，真实绑定的 HTTP health/read 请求和
  WebSocket heartbeat 在该区间持续完成；server event-loop gap 不出现 ≥500ms，且没有请求因维护超过 1 秒。
- **AC-2 前台写优先**：大库删除/归档同时持续发起前台写；维护事务按批结束，`SQLITE_BUSY` 会退避，前台写 max
  maintenance-attributed wait <1s，且无 maintenance transaction 跨文件 I/O。
- **AC-3 工作清单**：source guard 枚举所有周期性 SQLite/文件系统重工作；生产调用点没有直接在主 timer 中调用其
  job body。新增重 job 未登记 class/owner/worker adapter 时架构测试失败。
- **AC-4 分类正确**：intent 与 worktree 两条混合 ticker 被拆分；correctness/recovery fixture 的 boot/周期最坏延迟
  不增大；`repoBatchImport` 等纯内存微任务不被错误 IPC 化。
- **AC-5 日程**：hourly/daily schema、23:59/00:00、非法 HH:MM、无效时区、南北半球 DST gap/overlap、跨日和
  leap-day golden 全通过；daily 每个当地日期至多一个 slot。
- **AC-6 热更新与重启**：保存配置后 next-run 立即变化；当前 cycle 完成；重启前后同一 slot 不重复。错过 1 个或
  多个 slot 只产生一个 catch-up，长 cycle 跨下一 slot 只合并一个 pending。
- **AC-7 Worker 故障**：Worker 在 claim 前、事务内、事务提交后回执前、文件删除后 finalize 前分别退出时，事务回滚
  或 idempotent resume，stale lease 可接管，无重叠 runner、无永久 `running`。
- **AC-8 业务语义**：现有 events archive、retention、task archive、webhook GC、workspace GC、upload/input、token
  audit、backup prune、checkpoint 与 lifecycle/recovery characterization 结果逐项相等。
- **AC-9 活跃任务 fence**：任务在扫描后变 active、删除前变 active、claim 后 daemon 重启三类 race 均不会删除活跃
  workspace/input；advisory 内存快照不能绕过 durable recheck。
- **AC-10 状态 UI**：hourly/daily 字段、时区错误、last/current/next/backlog/error、保存后的 next-run 与窄屏/键盘
  行为有 frontend/component/E2E 覆盖；状态投影与 durable run 一致。
- **AC-11 大库并发门**：复用 RFC-311 的 100k tasks / 3M node runs / 约 10M events 级 seed，并在真实 HTTP socket
  上同时运行读、写和 WS 客户端。维护期间 50 并发常规门与 100 并发 scheduled soak 都无 ≥1s 全站停顿，错误率为 0；
  报告单列 API p50/p95/max、WS max gap、event-loop max gap、foreground write wait、job throughput 与 backlog。
- **AC-12 变异门**：删除 Worker hop、把 job body 接回主 timer、去掉批量上限/退避/durable fence/slot 唯一性、把
  recovery 改成 daily 或忽略 timezone 的任一 mutation 都必须使目标测试转红。
- **AC-13 交付**：实现只在用户批准后开始；最终以包含实现的 exact SHA GitHub Actions 主 CI 与 scheduled soak
  终态成功为交付依据，并记录 source pin、负载参数和完整指标。

## 9. 交付状态与批准记录

RFC 三件套、`design/plan.md` 与 `STATE.md` 已于 source pin 上完成；用户在确认 PostgreSQL server 不内嵌、数据库迁移另立
RFC 后，于 2026-08-28 明确回复“批准”，批准 D1～D11 并授权 RFC-338 生产实施；随后又明确要求“完整实现
RFC338 并提交上库”，因此本轮也取得了精确提交和推送授权。

实施以 live baseline `f5f573a533e8527857f47b9cf74023e3629985b1` 开始。主实现
`a6d97ccf4870a64730e7f3d8a88531fad2f56577` 以及后续 maintenance/Bun Worker 收口（最后一笔 RFC-338
专属 source fix 为 `e3433b76b0495a69dd9ab1b5d78994afe00763ca`）均已进入 final exact SHA
`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` 的 ancestry。重工作由独立 Worker/连接串行执行，日程、durable
ledger、bounded slice、BUSY 退让、状态 API/设置页及真实 HTTP/WS 2 秒阻塞门均已落地；真实编译二进制中 Worker
为 `Ready`。本地 50-client/full-seed、fault/characterization/mutation 证据均通过。

final exact SHA 的 Main CI run `33298828254` 为 35/35 jobs `completed/success`；同一 SHA 的 8 个 scheduled
workflows 也全部 `completed/success`。其中 maintenance soak run `33298851934` 在 100 clients、full seed、每阶段
180 秒下 PASS：maintenance 窗口 API max 250.0ms、foreground write max 203.5ms、WS max gap 357.9ms、
event-loop max gap 151.9ms、错误 0；123,996 条 SQLite statement 的 p95 上界为 50ms、max 131.1ms。报告 artifact
为 `9728401544`，digest `sha256:66d8b49f4f3a98c329645c98cf1bdd92aff0af5a21bd783f3209040e41e77ee0`。
AC-11 与 AC-13 据此闭合，RFC-338 状态为 Done；完整指标与 workflow 账本见 `verification-report.md`。

该交付只证明周期维护不再占用 API 事件循环；PostgreSQL、普通 query pool、多实例和水平扩展仍须另立 RFC。若未来调整
“默认频率、daily 溢出语义或正确性任务节奏”，必须先更新本 RFC 或由 successor RFC 明确取代。
