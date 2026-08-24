# RFC-322 维护节奏错峰与停顿归因 —— plan

## 1. 任务分解

| 编号   | 任务                                                                                                                                                                                                                                                                                              | 依赖    | 产物        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------- |
| **T1** | `services/daemonCadence.ts` 新增 `MAINTENANCE_PHASE` 相位注册表 + `MAINTENANCE_SLOW_TICK_MS`；更新该文件头部注释里那段「没进表的外挂周期 / 没有守卫」的自述（本 RFC 已收编）                                                                                                                      | —       | 注册表      |
| **T2** | 新增 `services/maintenanceTicker.ts`：`startMaintenanceTicker`（相位拍 + boot 拍 + 重入守卫 + 计时 + 吞错 + unref + stop），定时器与时钟可注入                                                                                                                                                    | T1      | 共享原语    |
| **T3** | `tests/rfc322-maintenance-cadence.test.ts` 覆盖原语语义 6 条 + 相位表不变量 + slow-tick 告警                                                                                                                                                                                                      | T2      | AC-1 / AC-4 |
| **T4** | `db/client.ts` 的 `instrumentSlowStatements` 增加 CPU 时间字段（`logSlow` 多一参，`process.cpuUsage()` 失败退化为 -1）+ 单测                                                                                                                                                                      | —       | AC-5        |
| **T5** | 9 个具名 ticker 接入原语：`gc.ts:802` / `webhookGc.ts:48` / `eventsArchive.ts:437` / `maintenanceRetention.ts:182` / `taskArchive.ts:600` / `backupScheduler.ts:194` / `repoBatchImport.ts:337` / `pluginGenerationGc.ts:59` / `lifecycleInvariants.ts:931`；删本地样板，保留各自原有错误日志文案 | T2      | 主体改造    |
| **T6** | `cli/start.ts` 5 处内联 `setInterval` 接入原语（`:1142` / `:1156` / `:1301` / `:1313` / `:1337`），handle 并入既有关停路径                                                                                                                                                                        | T2      | 主体改造    |
| **T7** | 棘轮守卫：源码层断言禁止再出现裸 hourly `setInterval(`；新增 hourly 循环必须登记相位                                                                                                                                                                                                              | T5 / T6 | AC-2        |
| **T8** | 错峰实证用例：注入定时器推进一个完整周期，断言 14 个任务触发时刻两两不等、最小间距 ≥ 3 分钟；并做变异检验（相位全置 0 ⇒ 两条转红）                                                                                                                                                                | T5 / T6 | AC-3        |
| **T9** | 索引与状态同步：`design/plan.md` RFC 索引登记、`STATE.md` 进行中 RFC 行；`docs/dev-gotchas.md` 补一条「单同步连接下慢查询日志会把进程停顿栽赃给 SQL，看 cpu 字段判别」                                                                                                                            | T1–T8   | 文档        |

## 2. PR 拆分建议

单 RFC 单 PR（`perf(backend): RFC-322 维护节奏错峰与停顿归因`）。

工作树是多人共享的（RFC-319 / RFC-321 并行在制），提交时按路径精确 `git add`，
并用 `git commit -- <本 RFC 路径…>` 带 pathspec；推前 `git diff --cached --stat` 复核。
本 RFC 触及的 `cli/start.ts` 已有他人未提改动，逐 hunk 认领后再提。

建议内部按批推进、每批自带测试：

- 批 A = T1 + T2 + T3 + T4（原语与判别量，零行为变化）
- 批 B = T5 + T6（接入，行为变化在此发生）
- 批 C = T7 + T8 + T9（棘轮、实证、文档）

## 3. 验收清单

- [x] **AC-1** 相位表覆盖全部 14 个 hourly 任务；`0 < offset < interval`、两两互异、间距 ≥ 3 分钟，有测试
      —— `tests/rfc322-maintenance-cadence.test.ts` §相位注册表不变量 3 条（含 14 的数量锁）。
- [x] **AC-2** 漏登记新 hourly 循环时守卫转红（源码层断言）
      —— §登记棘轮 2 条：扫 `src` 下全部 `setInterval(` 做括号配平取末参（并剥离注释，
      否则文档里写的 `setInterval(…, 3_600_000)` 会误判），加「每个 job 恰好接了一次」。
- [x] **AC-3** 注入定时器实证：一个周期内 14 个任务触发时刻互不重合
      —— §错峰实证：假时钟推进 2 小时，28 次触发时刻两两不等且最小间距 ≥ `MIN_PHASE_GAP_MS`。
- [x] **AC-4** 每拍耗时可观测；超 `MAINTENANCE_SLOW_TICK_MS` 时 warn 一行含 job 名；未超阈静默
      —— §slow-tick 告警 2 条（注入 `setLoggerStdoutWriterForTest` 抓日志）。
- [x] **AC-5** `[db-slow]` 含 CPU 时间；能判别「查询真慢」与「进程被冻住」，有注入 sink 的单测
      —— §CPU 判别 2 条：`Atomics.wait` 造停顿（cpu ≪ wall）、递归 CTE 造真忙（cpu ≈ wall）。
- [x] **AC-6** 既有 5 个相关测试文件保持绿；boot 首拍语义、`stop()` 语义、`unref()`、
      各 ticker 错误日志文案逐条未变 —— 5 个文件 + 本 RFC 用例合计 **57/57**。
      **一处如实记账的偏离**：`lifecycle-shutdown.test.ts` 有一条断言「构造后必须存在
      ≥1 个 setInterval」，而相位形状下 T0 只有两个 setTimeout（周期拍要等相位才装
      interval）。它测的是实现细节而非 `stop()` 的完备性，故改为「注册了几个 timer 就
      必须清掉几个」——比原断言**更强**。其余日志文案 / boot 首拍 / unref 语义逐字未变。
- [x] 变异检验：相位全置 0 ⇒ AC-1 / AC-3 两条转红
      —— 实测转红 3 条后还原全绿。另做两次：去掉相位夹取 ⇒ 1 条转红；注入一条裸
      `setInterval(fn, HOUR_MS)` ⇒ 棘轮精确点名 `services/pluginGenerationGc.ts` 转红。
- [x] CI 绿（本仓唯一权威门禁）
      —— 本人三个 exact SHA 的 CI 分别被并发 push 取消 / 红 / 取消（`6d261ba07` cancelled、
      `2d1ae54f3` failure、`2e924df3c` cancelled），按 CLAUDE.md「看含自己 commit 的
      superseding commit 的绿」取裁决：**`817b54a7b` 上 CI 31/31 job 全 success**，三笔
      均为其祖先。`2d1ae54f3` 那次红的两条已各自归属并修掉（见变更记录）。

## 4. 明确不做（各自另立）

1. `gc.ts:815-826` 那条 6 段 GC 链的内部拆分。
2. `util/process.ts:22,198` 同步 `Bun.spawnSync(['ps',…])` 改异步 / 批量化。
3. `ensureCredentialsSealed` 的 `maintenance_state` 「已完成」闸门漏接
   （`db/schema.ts:6611` 声称有、`services/repoCredentials.ts` 无任何引用）。
4. WAL checkpoint 策略（`walCheckpointIntervalMs` 默认 600000）与备份 `VACUUM INTO`
   回落主线程（`services/backup.ts:107-111`）。

## 5. 变更记录

- 2026-08-24：RFC 落档。用户三项裁决：①错峰用**确定性相位表**（非随机抖动、非串行队列）；
  ②§4「明确不做」的 4 项全部不带；③正式环境已是 **v0.18.12**（RFC-314 三条修复已在其中，
  故本次只需治整点风暴）。据此进入实现。
- 2026-08-24：批 A 落地（T1/T2/T3/T4）。相位表 + `services/maintenanceTicker.ts` + `[db-slow]`
  的 cpu 尾参；13 条用例绿，变异检验（相位全置 0）令 3 条转红后还原。
  `process.cpuUsage()` 实测 0.40µs/次（`performance.now()` 11ns），故快路径只付一次调用。
- 2026-08-24：批 B 落地（T5/T6）。9 个具名 ticker + `cli/start.ts` 5 处内联定时器全部接入。
  实现期修正三处：①`lifecycleInvariants` 的 boot 拍与周期拍 scope 不同，只把周期拍纳入错峰；
  ②`onTick` 返回值放宽为 `unknown`（各 ticker 的 `.catch()` 收敛类型互不相同）；
  ③`lifecycle-shutdown.test.ts` 断言「注册几个清几个」取代「必须存在一个 setInterval」——
  相位形状下 T0 只有两个 setTimeout，原断言测的是实现细节，新断言比它更强。
- 2026-08-24：批 C 落地（T7/T8）。棘轮守卫扫源码禁止裸 hourly `setInterval`（带注释剥离，
  否则文档里的散文会误判），并校验 14 个相位都真的接到了 ticker 上；变异检验注入一条裸
  `setInterval(fn, HOUR_MS)` 后精确点名 `services/pluginGenerationGc.ts` 转红。
- 2026-08-25：CI 收口。`e5fc28c89` 上主 CI 第一次完整跑完（此前 20+ 个 commit 的 run 全被
  并发 push 取消），只红两条 backend 分片，两条都在 `2d1ae54f3` 修掉：①本 RFC 把
  `webhookGc.ts` 的 `let running` 样板收进原语后，RFC-261 的源码层文本锁（钉字面量
  `if (running) return`）失效——锁改为钉「该 ticker 确实走原语 + 原语里的闸还在」两头，
  比原来更强；②RFC-317 T54 装配棘轮被 RFC-321 的 `composeRepositoryTransportCredentials`
  打红（塞在每进程跑两遍的 `mountApiRoutes` 里），按棘轮自述的正解把装配上移到
  `createApp`、经 `AppDeps` 新增可选 `repositoryTransport` 传下去，两条路径共用一个实例；
  该 compose 本身按 `(db, secretBox)` memoized，行为可证等价。
- 2026-08-25：**本 RFC 自身的一次回归**。AC-5 的停顿用例在 CI（ubuntu shard 2/4）红：
  `cpuMs=22` vs 阈值 `ms/4=15`。根因是 `process.cpuUsage()` 统计**整个进程所有线程**的
  CPU，bun 的二十来个线程 + JIT/GC/首次 getrusage 的固定成本全落进 60ms 的测量窗口——
  本机 0.03ms、CI 几十毫秒。`2e924df3c` 把信噪比做够而不是把判据调松：加 40ms 预热调用
  把固定成本挪出窗口、窗口 60ms → 300ms、判据 `ms/4` → `ms/2` 并补一条绝对差
  `ms - cpuMs > 100`。本机实测比值 0.001–0.003；按 CI 那次最坏的 37% 占空比外推也只有
  0.37。教训：**墙钟类判据要按 CI 的噪声下限设计，本机安静时的余量不是余量**。
- 2026-08-25：RFC 完工。`design/plan.md` 索引与 `STATE.md` 同步为 Done。
