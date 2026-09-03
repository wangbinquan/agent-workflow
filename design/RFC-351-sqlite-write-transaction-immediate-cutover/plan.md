# RFC-351 实施计划 — SQLite 写事务一律预占 writer

状态：**Done（2026-09-03）**。实现落于 `a3177b34e` → `06795e1d5` → `988d6b68e` → `d7595387e`；
hosted 取证见 §5。
current-source pin：`f4e3f3ca2`（立项时）。

## 0. 批准与完成口径

- [x] 对照 current source 逐处清点 37 个裸事务站点并按读/写顺序分类；
- [x] 复现 `SQLITE_BUSY_SNAPSHOT` 0ms 失败，确认它绕过 `busy_timeout`；
- [x] 确认既有账本 `RAW_TRANSACTION_SITES` 的理由只覆盖 S-10 一类危害；
- [x] 写 proposal / design / plan 三件套；
- [x] **用户批准**（2026-09-02 用户明确「开始」）；
- [x] AC-1～AC-7 与 published exact-SHA hosted closeout 全部满足（§4 逐条证据 / §5 hosted 取证）。

## 1. 任务分解

### T1 — 事故锁（先红）

- [x] 新建 `packages/backend/tests/rfc351-sqlite-write-transaction-immediate.test.ts`：
      双连接夹具构造「读快照 → 他人短提交 → 升级写」窗口，断言 DE 工具发布 store 路径不抛
      `SQLITE_BUSY_SNAPSHOT`；
- [x] 确认改造前该测试**红**（实测抛 `SQLiteError: database is locked`），改造后绿。
- 依赖：无。

### T2 — `digital-employee` 22 处

- [x] `sqliteRuntimeStore.ts`（14）、`sqliteAuthoringStore.ts`（5）、`writerCutoverPersistence.ts`（3，其中 1 处只读保留）；
- [x] 逐处 `db.transaction(` → `dbTxSync(db, `，回调体一字不改；
- [x] 该 context 既有测试全绿（与 T3/T4 合并跑：63 个文件 / 388 例 / 0 fail）。
- 依赖：T1。

### T3 — `development-automation` 10 处

- [x] `sqliteMissionStore.ts`（8，含 2 处转发包装逐个判定）、`sqliteUploadSessionStore.ts`（1）、
      `employeePlatformWorkItemPersistence.ts`（1，仅 SQLite 工厂那半）；
- [x] 该 context 既有测试全绿（同上一批）。
- 依赖：T1；与 T2 可并行（不同文件）。

### T4 — `event-center` 5 处

- [x] `sqliteEventStore.ts`（4）、`sqliteCustomEventSourceStore.ts`（1）；
- [x] 该 context 既有测试全绿（同上一批）。
- 依赖：T1；与 T2/T3 可并行。

### T5 — 账本与守卫

- [x] `RAW_TRANSACTION_SITES` 缩到只剩纯读站点（实际 1 处：`writerCutoverPersistence.migrationSnapshot`）；
- [x] 值从 `number` 升为 `{ count, why }`，`why` 必须同时覆盖两类危害；守卫加一条关键词断言；
- [x] 更新该守卫文件顶部的说明段：把「同步体即安全」修正为「同步体只关闭 S-10；BEGIN IMMEDIATE 才关闭 RFC-338 AC-2」。
- 依赖：T2～T4 全部完成（计数才稳定）。

### T6 — 账本重采与 permit 生命周期

- [x] 新增的 `@/db/txSync` import 抬高了 `cross-context-observed-imports` / `architecture-exceptions`；
      在 `ledger-baselines.json` 对应条目声明 `allowGrowth` 并点名 RFC-351；
- [x] 账本随实现同批重采（输入面已核只剩本 RFC 文件）；推前另做干净导出树逐字节自验；
- [x] **紧随其后的一笔已把该 permit 出账**（RFC-317 T17：permit 只为上涨那一笔背书）。
- 依赖：T5。

### T7 — Publication / hosted closeout

- [x] 精确路径提交、push 后按 exact SHA 跟踪 Main CI 与项目要求的定时 workflows（§5）；
- [x] 全绿后把三件套、`design/plan.md`、`STATE.md` 更新为 Done。
- 依赖：T6。

## 2. PR 拆分建议

单个 RFC 单个 PR（本仓主干直提）。逻辑 cohort：`T1` → `T2|T3|T4`（可分三笔）→ `T5+T6` 合成一笔
（账本与源码必须同笔，否则中间态让 N1b 在主干上红——2026-09-02 实撞）→ `T7` 文档收口。

## 3. 并发与冲突

| 面                               | 风险                          | 处置                                                      |
| -------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `sqliteRuntimeStore.ts` 等 store | 数字员工域可能有并行 RFC      | 开工前公告文件面；发现同文件 WIP 就停该切片               |
| `scheduler-audit-s10-…test.ts`   | 该守卫属 RFC-317 治理面       | 只改 `RAW_TRANSACTION_SITES` 与其说明段，不动扫描实现     |
| `architecture/*`                 | 多 session 同时重采会互相覆盖 | 只在 publication critical section 由本 RFC owner 单人生成 |

## 4. 验收清单（逐条证据，2026-09-03 全部满足）

| AC   | 结论 | 证据                                                                                                                                                                                                                                                                                                 |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | 满足 | `a3177b34e` 在 8 个文件里**删 36 行 `db.transaction(` / 加 36 行 `dbTxSync(`**（26 处读→写是其真子集，写-only 站点一并收敛）。「回调体逐字未变」是机器判据不是人眼：该提交生产源码 diff 里，剔除 wrapper 行、`import` 行与收尾 `})` 行之后**剩余改动行数 = 0**。逐文件计数见 `design.md §1`。        |
| AC-2 | 满足 | `RAW_TRANSACTION_SITES` 由 37 缩到 1；`scheduler-audit-s10-async-transaction-decorative.test.ts` 的 `countNonCommentMatches` 扫描与账本逐条相等的既有断言未放松，10 例全绿。                                                                                                                         |
| AC-3 | 满足 | 账本值由 `number` 升为 `{ count, why }`，并新增一条守卫：每条 `why` 必须同时命中 `/同步\|async\|半提交/` 与 `/IMMEDIATE\|BUSY_SNAPSHOT\|预占/`——**只答 async 那一半就红**。                                                                                                                          |
| AC-4 | 满足 | 红→绿在**干净导出树**上独立复现（不是回忆）：`git archive a3177b34e~1` 导出改造前源码、把事故锁与 fixture 放进去跑 ⇒ `SQLiteError: database is locked`（fail）；HEAD 上同一文件 ⇒ 10 例全绿。                                                                                                        |
| AC-5 | 满足 | 唯一保留的裸调用是 `writerCutoverPersistence.ts:131` 的 `migrationSnapshot`（纯读，不该无谓占写锁），账本 `why` 写明双危害各自为何不适用。同文件 207/245/282 三处仍是裸 `db.transaction`，但它们在 `createPostgresqlDigitalEmployeeWriterCutoverPersistence` 内，属 PostgreSQL 侧、不在本 RFC 范围。 |
| AC-6 | 满足 | 本 RFC 五笔提交触及的文件里**没有一个** migration / schema / route / ACL（逐笔 `--stat` 核过）；三个 context 既有测试 63 文件 / **388 例 / 0 fail**。                                                                                                                                                |
| AC-7 | 满足 | 见 §5。                                                                                                                                                                                                                                                                                              |

## 5. hosted closeout 取证（AC-7，2026-09-03）

**取证 SHA 的选法**：本 RFC 的实现链是 `a3177b34e` → `06795e1d5` → `988d6b68e` → `d7595387e`
（另有 `15b0a7cb7`，只给 RFC-331 那条语料扫描加了显式超时预算，不属本 RFC 生产面）。共享 `main`
上并发 push 会按 `ci.yml` 的 concurrency 取消 exact-SHA 的 run，故按仓规取**含全部这些提交的
后继 SHA**：`6752ec8c7`。9 条门里有 6 条是我在该 SHA 上 `workflow_dispatch` 手动触发的——
定时 workflow 本来只在夜间跑，而本 RFC 改的正是 SQLite 写事务路径、e2e 各腿是它最相关的被测面，
**拿改造前 SHA 上的旧绿来充数不诚实**。

| 门                        | 结论                          | 取证 SHA     | run           |
| ------------------------- | ----------------------------- | ------------ | ------------- |
| Main CI                   | success（35/35，attempt 1）   | `6752ec8c7`  | `33690423539` |
| Main CI（第二次独立绿）   | success                       | `9ac7c78d4`  | `33679571970` |
| e2e-full-nightly          | success（dispatch）           | `6752ec8c7`  | `33694276164` |
| e2e-webkit-nightly        | **见下方专段**                | `65179b8cf`  | `33697092006` |
| evidence-soak-nightly     | success（dispatch）           | `6752ec8c7`  | `33694282133` |
| git-protocols-e2e         | success（dispatch）           | `6752ec8c7`  | `33694285343` |
| integration-opencode      | success（dispatch）           | `6752ec8c7`  | `33694287966` |
| windows-platform          | success（dispatch）           | `6752ec8c7`  | `33694290704` |
| visual-regression-nightly | success                       | `c65635243`  | `33667298959` |
| maintenance-soak-nightly  | success（dispatch）           | `655cda189`  | `33695090095` |

**`e2e-webkit-nightly` 的那次红，逐条查清后判定不属本 RFC**：`6752ec8c7` 上的首轮（run `33694279201`）
挂在 `RFC-319 REPO-39` 的最后一条断言——半成品镜像目录 `repos/…~partial~<ULID>` 没被回收。四条独立证据：

1. **同一 SHA 上 chromium 通过**（`e2e-full-nightly` run `33694276164`，REPO-39 ✓ 37.2s）。本 RFC 改的是
   服务端 SQLite 事务行为，对浏览器无差别——**服务端回归不可能只在 webkit 上出现**。
2. **可达性为零**：以 `platform/persistence/sqlite/systemWorkspaceGc.ts`（`runPartialCloneGc` 的 owner）为根做
   传递 import 闭包，共 289 个文件，**本 RFC 改过的 8 个一个都不在其中**；该文件在本 RFC 之前就已经在用
   `dbTxSync`，本 RFC 一个字节没动它。
3. **`runPartialCloneGc` 根本不碰数据库**：只有 `readdirSync` / `statSync` / `rm`。
4. **根因是另一处的用例竞态**：`worktreeGc` 是 RFC-338 的 heavy 维护作业，
   `maintenanceJobRunner.ts:107` 把它切成 `['worktree','iso','scratch','orphan','partial']` 五个相位，
   **每个相位是 worker 的一次独立执行**，靠 `continuation.resumeAfterMs: 25` 串起来。用例先 `expect.poll`
   等 `orphan` 相位的产物消失，**紧接着零等待**断言 `partial` 相位的产物已消失——而后者至少还要再过一轮
   worker 调度。快就过、慢就红，与提交无关。用例注释里写的「4 分钟相位 `MAINTENANCE_PHASE.worktreeGc`」
   已经过期：`startWorktreeGcTicker` 全仓无调用者，是死代码。

`65179b8cf`（同样含本 RFC 全链）上重跑 run `33697092006` 为 success。**这条重跑只作旁证，不作通过依据**
（仓规：「绝不允许『重跑就过了』作为通过依据」）——真正的判据是上面 1～4 条。该竞态已按仓规记入
`docs/audit-backlog.md` 交由 RFC-338/349 维护 worker 的 owner 处置。

**直接闭合原始事故**：run `33690423539` 的 35 个 job 全绿，含 macOS / ubuntu / Windows 三平台
共 10 个 `Playwright e2e` 分片——`e2e/rfc319-digital-employee-p1.spec.ts`（DE-07 那两次 500 的
出处）就在其中。

**已知例外（沿用用户 2026-09-02 对 RFC-345 T10 的裁决，不阻塞本 RFC）**：`postgresql-evidence`
属 **RFC-349 owned**，其红与 SQLite 写事务无关；本 RFC 以「Main CI + 8 条既有定时 workflow 全绿」
为收口口径。

**本地补充证据**（都在 `git archive` 的干净导出树里跑，避开共享工作树上另外两个 session 的在制品）：
`655cda189` 上架构守卫 + S-10 账本守卫 + 事故锁 + RFC-331 语料扫描 = **441 pass / 0 fail**；
三个 context 既有测试 63 文件 **388 pass / 0 fail**。
