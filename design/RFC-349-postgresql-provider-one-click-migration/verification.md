# RFC-349 验证证据

本文件是 T11-B 要求的 verification report：把每一轮取证的**确切 SHA、确切数字**钉在这里，
让任何人都能按图复跑或反驳。**不写结论性形容词，只写测出来的数**。

状态：hosted `postgresql-evidence` 的 exact-SHA 正式门尚未绿（见 §3），因此 RFC-349 仍不是
Done。本机全量取证已 PASS，记在 §2。

---

## 1. 途中修掉的五个真缺陷

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

## 3. hosted `postgresql-evidence`（AC-14 正式门，未完成）

最近一次完成的 hosted 跑批（`6752ec8c7`，不含缺陷 4/5 的修复）：crash/resume **26/26**、
三平台 compiled smoke 全绿、migration status 错误 0、`postgresql-normal` 0 错误，但
`postgresql-maintenance` 3 个错误（SERIALIZABLE 逃逸）与 event-loop max 3,628.9ms 未过门。

当前在跑：`e211f1499`，含全部五个修复。**它绿之前 RFC-349 不标 Done。**
