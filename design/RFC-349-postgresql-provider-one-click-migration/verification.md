# RFC-349 验证证据

本文件是 T11-B 要求的 verification report：把每一轮取证的**确切 SHA、确切数字**钉在这里，
让任何人都能按图复跑或反驳。**不写结论性形容词，只写测出来的数**。

状态：**已完成（Done，2026-09-03）**。

- **产品代码冻结在 `b3883154eb1cfe575e578ee3cf2664fbb57ce797`**——此后各笔只动 CI 配置、测试守卫
  与文档（`git diff b3883154e..1e5a47893 -- 'packages/*/src'` 为空）。
- **AC-14 取证**：`b3883154e` 与 `adcea41bf` 两轮 hosted `postgresql-evidence` 的取证 job 均
  **Verdict PASS**——crash/resume **26/26**、三平台 compiled smoke 全绿、1320 万行大迁移
  **errors 0**、三相位各 **0 错误**、event-loop max 493.6ms / 498.1ms（门槛 500）。两条门槛
  `EVENT_LOOP_GAP_MS=500` 与 `HARD_FREEZE_MS=1000` 全程**未做任何调整**。
- **AC-15**：最终 SHA `1e5a47893` 的 Main CI **success**；九条适用 scheduled workflows 中
  **8 条**在 `26c511895`（含全部产品代码）上 success。第 9 条 `postgresql-evidence` 在最终 SHA
  上回归 lane 与 compiled 全绿、crash job 因**两条纯延迟门槛**未过（机器吞吐仅为独占跑批的 35%，
  `errors` 仍为 0），**用户 2026-09-03 判定「只是时间问题就不用重跑」**，据此收口。逐项归因见 §3。

本机全量取证记在 §2，hosted 逐轮与修复前后对照记在 §3。

---

## 1. 取证暴出的五个真缺陷（第一轮：可用性 / 性能）

全部由 4.5GB / 100 客户端全量取证暴出，各带回归用例。按发现顺序：

| #   | 缺陷                                                                             | 根因                                                                                                                                                                                                                                                                                | 修复 commit                                             |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | daemon 关停必失败，close participants / identity shutdown / 数据库关闭一步都没跑 | 关停先 seal 任务准入，再关 provider session；session freeze 会 pause 同一个 `TaskClaimGate`，旧实现对已 seal 的 gate 抛错，freeze 失败使 `close()` 在收尾之前就抛                                                                                                                   | `4ea647d17`                                             |
| 2   | 大迁移以 `sqlite-source-mutated` 收场                                            | SQLite 侧 post-commit 投影泵是**裸注册**，活过整个冻结窗口；任何漏出的提交都让它往源库写投影行（PostgreSQL daemon 早已把它组装成可暂停 handle）                                                                                                                                     | `4ea647d17`                                             |
| 3   | 割接后一分钟服务端记 **3210 次** 40001                                           | 逻辑拷贝是纯 INSERT，不给 PostgreSQL 留 planner 统计；没有统计的表被规划成顺序扫描，而顺序扫描在 SERIALIZABLE 下持**整表** predicate lock                                                                                                                                           | `58c99cf79`（拷贝后逐表 `ANALYZE`）                     |
| 4   | `PUT /api/tasks/:id/members` 的 SERIALIZABLE 冲突逃逸成 500（托管 31 次）        | SSI 的 predicate lock 粒度是**索引页**不是行，改不同任务的事务互判读写依赖。合成实验（10 万行 / 32 并发）逐项排除：基线 22.9%、去掉 fence 23.1%、整主键精确读 22.7%、删 user 索引 22.5%、每任务换不同 user 22.7%、去掉 insert **0%**、READ COMMITTED + 聚合根 `FOR UPDATE` **0.0%** | `787c22479`                                             |
| 5   | 迁移期间事件循环停顿 **18.1s**（托管 11.1s），100 个客户端 status 同时超时       | 两处叠加：①安全备份的 `PRAGMA quick_check` 留在主线程且跑了**两遍**（4.2GB 实测单次 4.4s，rename 前后各一次）；②`assertTargetCoverage` 的回执分组是 O(k²)（`node_run_events` 1 万个分片 ⇒ 约 5000 万次同步拷贝）                                                                    | `3d4fa2599`（校验挪 worker）+ `b56b23386`（分组线性化） |

**排除掉的歧路**（实测数据，避免重走）：

- preflight 逐表 `count(*)`：184 张表合计 **103ms**（走索引，1000 万行的表 91ms）——不是它；
- `PRAGMA quick_check` / `foreign_key_check` 在 preflight 里：各 4.4s / 4.6s，但跑在
  `openSqliteLogicalSourceWorker` 的独立线程上——不占主线程；
- `digestFile` 对 4.5GB 做流式 sha256：总耗时 5.6s，**最坏事件循环间隔 4.0ms**——确实是流式的；
- 「PostgreSQL 建索引吃满 CPU、daemon 被饿着」：4 个并行 index build 打 850 万行表，
  旁观进程最坏事件循环间隔 **8.1ms**——不是 CPU 饥饿，是真的 JS 主线程阻塞。

---

## 1b. 第二轮：用真适配器打真 PostgreSQL 才暴出的六个语义缺陷

第一轮的取证只跑 HTTP / WS 负载与迁移本身，**没有让业务适配器把真的写打进真的
PostgreSQL**；双 provider oracle 又用「只记录 SQL 文本」的假 runtime——它证明得了适配器走
哪条事务 / fence 路径，证明不了那条 SQL 在真 PostgreSQL 上跑不跑得动、跑出来一不一样。
把真适配器接到真库上之后，连着暴出六个**只在 PostgreSQL 上成立**的缺陷：

| #   | 缺陷                                                                                                                                                                                        | 用户可见后果                                                                                                                                                                          | 修复                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 6   | Drizzle 的 SQLite dialect 把「values 里没给、列也没有 default」的列渲染成字面量 `null`；SQLite 读作「分配下一个 rowid」，PostgreSQL 的 `GENERATED BY DEFAULT AS IDENTITY NOT NULL` 直接拒绝 | **选 PostgreSQL 时 `node_run_events` 一条都写不进去**——agent 每输出一行就要写它。同形的还有 `memory_distill_events` / `mcp_runtime_test_events`                                       | provider 投影给 identity 列带上 `default` 关键字作插入默认值（DDL 不受影响，它由 schemaContract 从 SQLite 声明产出）           |
| 7   | node run 的五个写手都先过 `task_execution_owners` 的条件 UPDATE；那张表每任务一行，小部署上就是几行的小表，predicate lock 落到**页**这一级                                                  | 全新安装 / 小库割接后，8 并发满速冲突率 **81.2%**、逃逸 **234**；4 并发 × 20 次/秒（真实速率）也有 63.0% 与 1 次逃逸                                                                  | 改走 READ COMMITTED + `node_runs` 行锁（锁序：owner fence 之后），实测 **0% / 0 逃逸 / 893 ops/s**                             |
| 8   | SQLite 的 `LIKE` 对 ASCII 大小写不敏感，PostgreSQL 的敏感                                                                                                                                   | 记忆列表 `?search=`、数字员工案件列表 `?q=` 切库后**静默少召回**（`'%runbook%'` 找不到 `Deploy Runbook`）                                                                             | PostgreSQL 侧改 `ilike`；三处按存量 id / 常量前缀匹配的 `like` 明确保留并在测试里写明理由                                      |
| 9   | 两个 provider 的 NULL 排序**正好相反**（SQLite ASC 把 NULL 排最前，PostgreSQL 排最后）                                                                                                      | human gate 的 `claimExpiresAt` 认领扫描与 event-center 的 `nextScanAt` observer 扫描都**故意**把 NULL 收进候选集；切库后它们掉到队尾，只要 due 的存量填满 LIMIT，新条目**永远轮不到** | 新增 `ascNullsFirst` / `descNullsLast` 复刻 SQLite 语义，13 处可空列 ORDER BY 改用；6 处证明不可能有 NULL 的保持原样并写明判据 |
| 10  | `count(*)` 是 int8、`sum(bigint)` 是 numeric，驱动按规范交回**字符串**；裸 ``sql<number>`count(*)` `` 没有 mapper                                                                           | `total + 1` 变字符串拼接、JSON 响应里数字变字符串、分页与配额判断被静默改写                                                                                                           | 19 处改用 Drizzle 的 `count()`（自带 `mapWith(Number)`），自定义聚合显式 `.mapWith(Number)`                                    |
| 11  | SQLite 没有布尔类型，`0`/`1` 就是 false/true；PostgreSQL 的 `boolean` 拒绝整数混入                                                                                                          | 定时任务的失败自停用 `CASE WHEN … THEN 0 ELSE enabled END` 抛 42804——**任务永远不会被自动停用**，且每次失败上报本身都失败                                                             | 两侧统一 `THEN false`（SQLite 3.23+ 认 false 为 0）                                                                            |

**为什么这一类以前抓不到、以后怎么抓**：新增
`rfc349-postgresql-write-matrix.integration.test.ts` —— 对 contract 里每一张有 PostgreSQL
投影的表渲染并执行一次真 INSERT（插完即回滚），判据按 SQLSTATE 分类：23503/23514/22003/
22P02 属于「合成值不满足业务约束」，其余（23502 not-null、42703 未知列、42804 类型不匹配、
42883 未打 shim 的 SQLite 函数）一律算缺陷。已验证它对缺陷 6 是敏感的：把修复临时撤掉后
它精确报出四张表的 23502。它挂在 `postgresql-evidence` 的 oracle 步骤上，用独立的一次性库。

另外三条**静态**守卫补住写矩阵覆盖不到的读 / 表达式面，每条都可执行地钉住前提（在
`bun:sqlite` 里实测 SQLite 的 LIKE / NULL 排序 / `false` 语义），并且都验证过对回退敏感：
`rfc349-provider-search-case-parity` / `rfc349-null-ordering-parity` /
`rfc349-postgresql-numeric-projection` / `rfc349-boolean-expression-parity`。

---

## 2. 本机全量取证（PASS）

- 实现 SHA：`952484e387237c1930d8a0c7b308e80dd16df67a`
- 生成时间：`2026-09-03T02:29:35.684Z`
- runner：darwin/arm64；外置 PostgreSQL：`127.0.0.1:62815`（容器，独立进程）
- 模式：`--mode large-soak --scale full --clients 100 --duration-seconds 180`
- **Verdict: PASS，`failures: []`**

数据集：`4,533,977,088` 字节 / `13,200,595` 行 / 10 万任务 / 300 万 node run / 1000 万事件。

大迁移（operation `dbm_01M1JE8S0YKD2BJ9D0BHR3QSCF`，终态 `accepting-writes`，revision 194）：

| 指标                  |                                                                            值 |
| --------------------- | ----------------------------------------------------------------------------: |
| 耗时                  |                                                                  2,872,345 ms |
| 拷贝行数 / 字节       |                                           13,208,368 行 / 21,262,990,289 字节 |
| 吞吐                  |                                                                 4,598.5 行/秒 |
| status 采样           |                       2,322,851 次，p50 18.2ms / p95 65.0ms / **max 573.8ms** |
| status 错误           |                                                                         **0** |
| 事件循环最大停顿      |                                                                   **221.4ms** |
| 生产连接池等待        |                               p50 0.012ms / p95 0.036ms / max 0.078ms，失败 0 |
| 外部 Bun.SQL 池探针   |                                    26,182 次，p95 43.7ms / max 66.8ms，错误 0 |
| WebSocket             | 100 连接 / 8,400 消息 / **错误 0** / 最大间隔 256.4ms / provider 切换关闭 100 |
| logical backup digest |     `sha256:cb521bbf9f9abaedb55586600416772d8c038cc3455fd8aa670206359943babf` |

三个运行相位：

| 相位                     | HTTP 错误 | API max | 事件循环 max |
| ------------------------ | --------: | ------: | -----------: |
| `sqlite-normal`          |         0 | 130.7ms |      129.5ms |
| `postgresql-normal`      |         0 | 147.6ms |       57.8ms |
| `postgresql-maintenance` |         0 | 249.0ms |       59.8ms |

12 个维护作业全部 `succeeded`（`eventsArchive` 1540 片、`webhookDeliveryGc` 202 片、
`worktreeGc` 5 片、`retentionSweep` 4 片、`tokenAuditGc` 2 片，其余各 1 片）。

**停顿归因**：最慢的样本是 `accepting-writes` 阶段的 ~570ms（provider 交接窗口），在 1000ms
硬门槛之内；daemon 侧的 `event loop stalled`（>1s 才记）整场**一条都没有**。

### 修复前后对照（同一台机器、同一数据集）

| 指标             | 修 quick_check 之前 | 挪 worker 之后 | 分组线性化之后 |
| ---------------- | ------------------: | -------------: | -------------: |
| 事件循环最大停顿 |            18,128ms |        2,746ms |      **221ms** |
| status 最大延迟  |            15,002ms |        2,801ms |      **574ms** |
| status 错误      |                 101 |              0 |          **0** |

---

## 3. hosted `postgresql-evidence`（AC-14 正式门）

| 跑批       | SHA                                            | 结果                                                                                                                        |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-02 | `6752ec8c7`                                    | crash/resume 26/26、三平台 compiled 全绿；`postgresql-maintenance` 3 个 SERIALIZABLE 逃逸、event-loop max **3628.9ms**      |
| 2026-09-03 | `e211f1499`                                    | 含第一轮五个修复。三相位各 0 错误、迁移 0 错误；唯一未过 event-loop max **688.5ms**                                         |
| 2026-09-03 | `40b76d0df`                                    | 含六个语义修复 + 写矩阵首次在 CI 里对真库跑通。唯一未过 event-loop max **654.9ms**                                          |
| 2026-09-03 | **`b3883154eb1cfe575e578ee3cf2664fbb57ce797`** | **Verdict PASS**（run `33722869768`）                                                                                       |
| 2026-09-03 | `adcea41bf`                                    | 分片修复后。**Verdict PASS**（run `33732387691`）；吞吐已降到 3874.4 行/秒,event-loop max **498.1ms**（门槛 500,余量 0.4%） |
| 2026-09-03 | `1e5a478939003832a8df5c617c1fd5fe86a74ca9`     | 环境补齐后。回归 lane 与 compiled 全绿;crash job **Verdict FAIL**（run `33743436967`）——**纯延迟门槛**,归因见下             |

**最终一轮（`b3883154e`）**：

- Crash/resume **26/26**；三平台 compiled smoke（Linux / macOS / Windows）全绿；
- 大迁移：13,209,092 行 / **6,543.8 行每秒** / 2,018,552.8ms，**errors 0**；
- status p95 **57.7ms** / max 651.0ms；**event-loop max 493.6ms**（门槛 500ms）；
- 三个相位 `sqlite-normal` / `postgresql-normal` / `postgresql-maintenance` 各 **0 错误**，
  API p95 14.4 / 35.8 / 53.7ms。

与上一轮（`40b76d0df`，同口径、同 runner 规格）的逐项对照，差别只有本轮那三处迁移路径的减法：

| 指标                  |   `40b76d0df` |       `b3883154e` |   变化 |
| --------------------- | ------------: | ----------------: | -----: |
| event-loop max        |    654.9ms ❌ |    **493.6ms ✅** | −24.6% |
| 迁移耗时              | 3,528,429.8ms | **2,018,552.8ms** | −42.8% |
| 拷贝吞吐              | 3,743.6 行/秒 | **6,543.8 行/秒** | +74.8% |
| status p95            |       150.2ms |        **57.7ms** | −61.6% |
| 迁移错误 / 三相位错误 |     0 / 0-0-0 |         0 / 0-0-0 |      — |

排名最前的 12 条停顿仍是 `accepting-writes` 阶段 ~651ms 的 status 等待——那是**割接窗口本身**
（`handover()` 屏障，进程级 provider 选择正在移动时把新到达的 listener 调用挡住），有意、有界，
硬门槛 `HARD_FREEZE_MS = 1000` 留有 35% 余量；D3 本来就写明 V1 是维护窗口、不承诺零停机。

#### 同 run 里 `Full regression (backend)` lane 的中断：lane 拓扑缺陷，非产品失败

`b3883154e` 是这条 lane **有史以来第一次真正执行**——此前每个 evidence run 的取证 job 都是红的，
`needs: [crash-large-and-soak, compiled-external-postgresql]` 把它全 skip 了（近 8 个 run 逐个查过，
该 job 的 conclusion 一律缺席）。两次执行都以
`The runner has received a shutdown signal / The operation was canceled` 中断，证据链：

| 观测              | 第 1 次                       | 第 2 次                       |
| ----------------- | ----------------------------- | ----------------------------- |
| 起止              | 07:13:41Z → 07:33:37Z（~20m） | 07:42:49Z → 08:05:37Z（~23m） |
| 失败断言 `(fail)` | **0**                         | **0**                         |
| 断点              | `skill-zip-commit` 附近       | `rfc199-…-ratchet` 附近       |
| 已跑通用例        | 8,895                         | 9,158                         |

（日志里 grep 到的三条 `(fail)` 是**测试名里含 "(fail)" 字样**的 `(pass)` 行，非真失败。）

- **不是超时**：job 声明 `timeout-minutes: 90`，两次都在 20–23 分钟被掐；超时的报错文案也不是这条。
- **不是产品回归**：同一 SHA 上 Main CI（run `33722386454`）用**四个 ~7m 的 ubuntu 分片**跑完
  **同一批文件、同一套 env**（`RUN_GIT_NETWORK=1` + `RUN_CHAOS=1`），八片（ubuntu×4 + macOS×4）
  全绿；两次断点还不在同一个文件。
- **是 lane 自身的拓扑**：Main CI 早就写明后端套件（~740 文件、`--isolate` 串行）必须分片，
  这条 lane 却把四片的量塞进一台 VM 串行跑（~29m + 4 倍的临时产物），从没被验证过能跑完。

修复（`adcea41bf`）：lane 按 Main CI 同样确定性分 4 片。Bun 按路径分配，每个文件仍恰好跑一次，
覆盖面不变，单 VM 负载降到 1/4。新增守卫锁住这个拓扑——四条 backend lane 对应 shard 1..4 无缺口、
step 条件收所有分片、与 Main CI 参照拓扑对齐；实测把 lane 改回单片时该用例变红（缺一片会静默
少跑四分之一套件却仍报绿，所以逐条断言）。

`EVENT_LOOP_GAP_MS = 500` 与 `HARD_FREEZE_MS = 1000` 两条门槛全程**未做任何调整**。

### 最终 SHA（`1e5a47893`）那轮 crash job 的 FAIL:机器慢了 2.85 倍,不是产品退化

**先说结论**:被击穿的两条**都是纯延迟门槛**,没有任何正确性断言失败。用户 2026-09-03 判定
「只是时间问题就不用重跑」,因此本 RFC 的 AC-14 取证以 `b3883154e`（独占跑批,Verdict PASS）与
`adcea41bf`（Verdict PASS）为准,这一轮记录在案但不作为退化证据。

失败行:`migration status max 1776.8ms >= 1000ms; migration event-loop max 983.8ms >= 500ms`。

**三轮同代码对照**（`git diff b3883154e..HEAD -- 'packages/*/src'` **为空**,产品代码逐字未变;
中间各笔只动 CI 配置、测试守卫与文档）:

| 跑批        | 拷贝吞吐          | 迁移耗时          | event-loop max | status max | 迁移错误 | 判定     |
| ----------- | ----------------- | ----------------- | -------------- | ---------- | -------- | -------- |
| `b3883154e` | **6,543.8 行/秒** | 2,018,552.8ms     | 493.6ms        | 651.0ms    | 0        | PASS     |
| `adcea41bf` | 3,874.4 行/秒     | 3,409,070.0ms     | 498.1ms        | 833.0ms    | 0        | PASS     |
| `1e5a47893` | **2,298.3 行/秒** | **5,747,323.0ms** | 983.8ms        | 1776.8ms   | 0        | **FAIL** |

三轮迁移行数一致（13,209,092 / 13,208,100 / 13,208,900）、错误全 **0**;吞吐 6544 → 3874 → 2298
单调下滑,两条延迟门槛严格跟着走。**同样的活,机器每秒只做到独占那轮的 35%**,于是以毫秒计的门槛
被击穿——这正是延迟门槛的定义,它测的是机器速度和代码速度的**乘积**。

**为什么机器慢,没有证据,不要写成结论**。当时仓里确有其他 run 与该窗口重叠（10:17–12:34;
12:02–12:04 那批 event-loop 停顿正好撞上 11:59–12:23 那一簇）,但 **GitHub 托管 runner 是各自独立
的 VM**,同仓别的 run 不共享这台机器的 CPU——并发只会让 job 排队,不会让已在跑的 job 变慢。所以
「我并发派多了取证跑批把自己挤慢了」这个说法**时间上相关、因果上未证**,只能记作可能的诱因,
真正确定的是托管 runner 本身存在这个量级的性能方差。

**给下一个人的提醒**:`adcea41bf` 那轮 PASS 时 event-loop max 已经是 498.1ms、离 500ms 门槛只剩
**0.4%**——那是警告信号,不是「过了就行」。这两条门槛在慢机器上会假红,读到它们红时**先看吞吐
和 `errors`**:错误为 0、行数对得上、只有毫秒数超标,就是机器问题,不要当成产品退化去改代码。

### 修复后的本机对照跑批（同一台机器、同一数据集）

`--mode large-soak --scale full --clients 100`，**Verdict PASS**：

| 指标               |                      修复前基线 |        含两处修复 |   变化 |
| ------------------ | ------------------------------: | ----------------: | -----: |
| 迁移耗时           |                   3,233,171.9ms | **2,312,439.7ms** | −28.5% |
| 拷贝吞吐           |                   4,083.1 行/秒 | **5,708.9 行/秒** | +39.8% |
| status p95         |                          82.8ms |        **44.5ms** |   −46% |
| daemon 停顿 ≥120ms | **180 次**（p50 134 / p95 175） |          **3 次** |   −98% |
| event-loop max     |                         251.1ms |           240.9ms |    −4% |
| 迁移错误           |                               0 |             **0** |        |
| 三相位错误         |                       0 / 0 / 0 |     **0 / 0 / 0** |        |

**为什么 max 几乎没动**：稠密分量（每块的重复工作）整体掉到 120ms 门槛以下了——180 次变 3 次
就是这件事；剩下的 max 是稀疏的 GC 尖峰，与每块工作量不成正比。托管侧同期的分布印证了这个
分解：修复前 266 次 ≥300ms、p50 **363ms**、p95 553ms、max 655ms，堆增量 235 正 / 31 负，
即**稠密分量就是分配密集的阻塞计算**——正是被砍掉 77% 的那部分。

第三处修复（Worker 回传的行不再逐值复验，每块少分配约 1.5 万个对象、全程约 7.9 亿）冲的就是
剩下那个 GC 尖峰。

第三处修复的功能烟测（`--scale small`，45MB / 132,100 行）：**Verdict PASS**，132,186 行迁移
完成、迁移错误 **0**、event-loop max 68.4ms。

**本轮优化到此为止**（用户 2026-09-03 决定）：迁移是一次性维护窗口的事，功能面已由写矩阵与
四条 parity 守卫兜住，不再继续追 `EVENT_LOOP_GAP_MS = 500` 这条自设的软门槛——硬门槛
`HARD_FREEZE_MS = 1000` 在每一轮里都是过的（本机 585ms / 托管 617ms，都在 `accepting-writes`
的割接窗口内，是有意的、有界的 handover 屏障）。

### 修复前的本机基线（同一台机器、同一数据集，供对照）

`--mode large-soak --scale full --clients 100`，**Verdict PASS**：13,201,463 行 / 4083.1 行每秒，
迁移错误 **0**，三个相位（`sqlite-normal` / `postgresql-normal` / `postgresql-maintenance`）
各 **0** 错误。事件循环最大停顿 **251.1ms**（daemon 侧 120ms 门槛下共 180 次，p50 134ms /
p95 175ms）。

排名最前的 12 条停顿都不是事件循环，而是 `accepting-writes` 阶段 **~605–619ms 的 status
等待**——那是**割接窗口本身**：`switchProviderComposition` 期间 `handover()` 把**新**到达的
listener 调用挡在屏障后（进程级 provider 选择正在移动，放行就会用旧 composition 编译出目标
形状的 SQL）。它是有意的、有界的，硬门槛是 1000ms，本机与托管分别留有约 38% / 36% 的余量；
D3 本来就写明 V1 是维护窗口、不承诺零停机。托管那 11 条 ~643ms 是同一件事。
