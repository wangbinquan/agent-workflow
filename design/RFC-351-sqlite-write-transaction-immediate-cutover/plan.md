# RFC-351 实施计划 — SQLite 写事务一律预占 writer

状态：Draft（2026-09-02）；**等待用户批准后才进入实现阶段**。
current-source pin：`f4e3f3ca2`（实现开工前须 fresh fetch 并重新确认站点计数）。

## 0. 批准与完成口径

- [x] 对照 current source 逐处清点 37 个裸事务站点并按读/写顺序分类；
- [x] 复现 `SQLITE_BUSY_SNAPSHOT` 0ms 失败，确认它绕过 `busy_timeout`；
- [x] 确认既有账本 `RAW_TRANSACTION_SITES` 的理由只覆盖 S-10 一类危害；
- [x] 写 proposal / design / plan 三件套；
- [ ] **用户批准**（未获批准前不得改任何生产代码）；
- [ ] AC-1～AC-7 与 published exact-SHA hosted closeout 全部满足后才能 Done。

## 1. 任务分解

### T1 — 事故锁（先红）

- [ ] 新建 `packages/backend/tests/rfc351-sqlite-write-transaction-immediate.test.ts`：
      双连接夹具构造「读快照 → 他人短提交 → 升级写」窗口，断言 DE 工具发布 store 路径不抛
      `SQLITE_BUSY_SNAPSHOT`；
- [ ] 确认改造前该测试**红**（这是 AC-4 的前半）。
- 依赖：无。

### T2 — `digital-employee` 22 处

- [ ] `sqliteRuntimeStore.ts`（14）、`sqliteAuthoringStore.ts`（5）、`writerCutoverPersistence.ts`（3，其中 1 处只读保留）；
- [ ] 逐处 `db.transaction(` → `dbTxSync(db, `，回调体一字不改；
- [ ] 该 context 既有测试全绿。
- 依赖：T1。

### T3 — `development-automation` 10 处

- [ ] `sqliteMissionStore.ts`（8，含 2 处转发包装逐个判定）、`sqliteUploadSessionStore.ts`（1）、
      `employeePlatformWorkItemPersistence.ts`（1，仅 SQLite 工厂那半）；
- [ ] 该 context 既有测试全绿。
- 依赖：T1；与 T2 可并行（不同文件）。

### T4 — `event-center` 5 处

- [ ] `sqliteEventStore.ts`（4）、`sqliteCustomEventSourceStore.ts`（1）；
- [ ] 该 context 既有测试全绿。
- 依赖：T1；与 T2/T3 可并行。

### T5 — 账本与守卫

- [ ] `RAW_TRANSACTION_SITES` 缩到只剩纯读站点（预计 1 处 + 视 T3 判定的转发包装）；
- [ ] 值从 `number` 升为 `{ count, why }`，`why` 必须同时覆盖两类危害；守卫加一条关键词断言；
- [ ] 更新该守卫文件顶部的说明段：把「同步体即安全」修正为「同步体只关闭 S-10；BEGIN IMMEDIATE 才关闭 RFC-338 AC-2」。
- 依赖：T2～T4 全部完成（计数才稳定）。

### T6 — 账本重采与 permit 生命周期

- [ ] 新增的 `@/db/txSync` import 会抬高 `cross-context-observed-imports` / `architecture-exceptions`；
      在 `ledger-baselines.json` 对应条目声明 `allowGrowth` 并点名 RFC-351；
- [ ] 按「先提源码、再 `git archive` 干净导出树重采、逐字节自验」的姿势生成 `architecture/*`；
- [ ] **紧随其后的一笔必须把该 permit 出账**（RFC-317 T17：permit 只为上涨那一笔背书）。
- 依赖：T5。

### T7 — Publication / hosted closeout

- [ ] 精确路径提交、push 后按 exact SHA 跟踪 Main CI 与项目要求的定时 workflows；
- [ ] 全绿后把三件套、`design/plan.md`、`STATE.md` 更新为 Done。
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

## 4. 验收清单

- [ ] AC-1 26 处读→写全部经 `dbTxSync`，回调体逐字未变
- [ ] AC-2 账本与磁盘逐条相等
- [ ] AC-3 保留条目带双危害理由，守卫强制
- [ ] AC-4 事故锁改造前红、改造后绿
- [ ] AC-5 只读站点保留裸调用并写明理由
- [ ] AC-6 无 schema/migration/wire/权限变化，三个 context 既有测试全绿
- [ ] AC-7 exact-SHA hosted closeout 全绿
