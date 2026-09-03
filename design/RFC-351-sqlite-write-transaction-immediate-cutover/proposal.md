# RFC-351 — SQLite 写事务一律预占 writer（裸 `db.transaction` 收敛到 `dbTxSync`）

- 状态：**Done（2026-09-03）**（2026-09-02 用户批准实现；实现 `a3177b34e` → `06795e1d5` → `988d6b68e` → `d7595387e`，逐 AC 证据见 [plan.md §4](./plan.md)，hosted 取证见 plan.md §5）
- current-source pin：`f4e3f3ca2`（`HEAD=origin/main`）
- 前置：[RFC-093](../RFC-093-db-tx-sync/design.md)（`dbTxSync` 原语）、
  [RFC-338](../RFC-338-maintenance-worker-daily-window/proposal.md) AC-2（`BEGIN IMMEDIATE`）、
  RFC-317 T37 / CC-04（`RAW_TRANSACTION_SITES` 站点账本）
- 影响域：`digital-employee` / `development-automation` / `event-center` 三个 bounded context 的 infrastructure 层

## 1. 摘要

本仓已经有一条明确不变量：**写事务必须先预占 writer，再取读快照**——`dbTxSync` 用
`{ behavior: 'immediate' }` 实现它（`db/txSync.ts:51-57`），RFC-338 AC-2 写下了理由。但全仓
**37 处** SQLite 写事务绕过 `dbTxSync` 直调 drizzle 的 `db.transaction(...)`，其中 **26 处是「先读后写」**
的形态。deferred 事务的读→写升级会以 `SQLITE_BUSY_SNAPSHOT` **立即失败并绕过 `busy_timeout`**，
而它是裸 `SQLiteError`、不是 `DomainError`，于是在 HTTP 边界被兜成 **500 `internal-error`**。

这不是理论风险：2026-09-02 主干 CI（run `33638907352`）上
`e2e/rfc319-digital-employee-p1.spec.ts` 的 `beforeAll` 两次 `POST …/tools/{id}/publish` 都以
500 收场，落点正是这 37 处之一（`sqliteAuthoringStore.ts:557` 的 `publishTool`）。

## 2. Current-source 结论

### 2.1 站点账本存在，但它的安全理由只覆盖了一半危害

`RAW_TRANSACTION_SITES`（`scheduler-audit-s10-async-transaction-decorative.test.ts:203-215`）逐文件登记了这 37 处，
并给出理由：

> 现存 37 处全部在 store / infrastructure 层：那里的对象**拥有**自己的事务边界，回调体是同步的
> drizzle 执行面（上面那条零容忍断言持续证明它们不含 async 体）。

该理由针对的是 **S-10 的危害**：async 回调让 bun:sqlite 在第一个 await 处提前 COMMIT（半提交）。
「回调体是同步的」确实关闭了这一条。**但 `dbTxSync` 还承担第二个、互相独立的职责**——
`{ behavior: 'immediate' }`。账本的理由完全没有涉及它，因此这 37 处对 RFC-338 AC-2 那条不变量是
**未被覆盖的逃逸口**，而账本读起来却像「已评估、可接受」。

### 2.2 危害是可复跑的，不是推测

两连接同库，把一次短提交插在读与写之间（等价于维护 Worker 的 bounded transaction）：

```
裸 deferred（store 的形态）：抛出 Error code=SQLITE_BUSY_SNAPSHOT 耗时 0ms —— database is locked
```

**0 毫秒**——没有等主连接那 5 秒 `busy_timeout`（`db/client.ts:187-188`）。RFC-338 已有的绿测试
`rfc338-maintenance-slices.test.ts:513`「foreground dbTxSync waits at BEGIN IMMEDIATE instead of
failing a read-snapshot upgrade」从正面证明了 `dbTxSync` 能挡住同一场景。

### 2.3 并发写手真实存在

维护 Worker 是独立线程独立连接（`maintenanceWorkerSupervisor.ts:97`、`:370` `busyTimeoutMs: 50`），
准入连接更短（`maintenanceService.ts:30` `ADMISSION_BUSY_TIMEOUT_MS = 5`）。它按拍提交、每次都短——
正是 `txSync.ts` 注释里描述的「a short maintenance commit is in flight」。

### 2.4 37 处的形态分布（实测）

| 形态             | 处数 | 是否暴露于 BUSY_SNAPSHOT   |
| ---------------- | ---: | -------------------------- |
| 读 → 写          |   26 | **是**（读快照后升级）     |
| 写 → 读          |    4 | 否（首语句即取 writer）    |
| 只写             |    4 | 否                         |
| 只读             |    1 | 否（且不应改成 immediate） |
| 其它（转发包装） |    2 | 随被包裹的回调             |

按文件：`sqliteRuntimeStore.ts` 14、`sqliteMissionStore.ts` 8、`sqliteAuthoringStore.ts` 5、
`sqliteEventStore.ts` 4、`writerCutoverPersistence.ts` 3、`sqliteCustomEventSourceStore.ts` 1、
`sqliteUploadSessionStore.ts` 1、`employeePlatformWorkItemPersistence.ts` 1。
全部是顶层 `db.transaction((`，**无嵌套**（无 `tx.transaction(`），接收者一律是 `db`。

### 2.5 为什么一直没人发现

500 分支其实打了日志（`util/errors.ts:153-157` `log.error('unhandled error', {stack})`），但 e2e harness
只把 daemon 输出留在内存 tail 里（`e2e/harness.ts:742-743`），CI 上既不落盘也不附到报告。于是这类红
在 CI 上只剩一句 `internal-error`，天然被读成「玄学 flake」。该可观测性缺口**不在本 RFC 范围内**：
另一个 session 已在工作树里写好了对应的 harness 修复（回显 daemon 的 `unhandled error` 行），
但其作者 session 已结束、改动尚未提交，归属确认中。本 RFC 不依赖它，也不代其提交。

## 3. 目标

1. 每一处 SQLite 写事务都先预占 writer：把 26 处「读→写」（以及可安全转换的写路径）改走 `dbTxSync`；
2. `RAW_TRANSACTION_SITES` 逐条缩减；仍需保留的站点必须给出**同时覆盖两类危害**的理由（async 半提交
   与 deferred 升级），而不是只答前者；
3. 守卫升级：新增裸站点时，账本必须回答「为什么这里不需要 BEGIN IMMEDIATE」，否则红；
4. 用一条红→绿测试锁住本次事故形态：DE 工具发布在竞争提交下不再 500。

## 4. 非目标

- 不动 PostgreSQL 侧的 `.transaction(async …)`（不同引擎、不同并发语义，S-10 守卫已按 provider 划界）；
- 不改任何业务语义、wire、schema 或 migration；事务边界与其内部语句顺序保持逐字不变；
- 不合并 / 不重做 RFC-338 的维护 Worker，也不调整其 busy timeout 旋钮；
- 不把 `dbTxSync` 扩成通用仓储原语，不引入新的事务抽象层；
- 不顺带做安全加固（依 `CLAUDE.md` 明令，本 RFC 只审功能正确性）。

## 5. 用户故事

- 作为使用数字员工的用户，我在维护任务恰好提交的瞬间点「发布工具」，得到的是正常结果，
  而不是一个没有任何解释的「内部服务器错误」；
- 作为值班的开发者，我在 CI 上看到的红要么是真实回归、要么带着可归因的服务端堆栈，
  不会再出现「同一棵生产树一绿一红、谁都说不清」的情形；
- 作为下一个在 store 层加事务的人，我要么用 `dbTxSync`，要么必须在账本里说清为什么这一处
  可以不预占 writer——机器会逼我回答。

## 6. 验收标准

- **AC-1**：26 处「读→写」站点全部改走 `dbTxSync`；事务边界、语句顺序、返回值与抛错逐字不变；
- **AC-2**：`RAW_TRANSACTION_SITES` 相应缩减，且 `countNonCommentMatches` 扫描与账本逐条相等（既有守卫不放松）；
- **AC-3**：账本的保留条目各自带**双危害理由**（async 半提交 + deferred 升级），守卫强制该字段存在；
- **AC-4**：新增红→绿测试：在另一连接完成短提交的窗口内，DE 工具发布路径不再抛 `SQLITE_BUSY_SNAPSHOT`、
  也不再返回 500（改造前该测试红）；
- **AC-5**：`只读` 站点不被改成 immediate（不无谓占写锁），并在账本里写明理由；
- **AC-6**：无 schema / migration / wire / 权限点变化；既有 digital-employee、development-automation、
  event-center 的行为测试全绿；
- **AC-7**：published exact-SHA 的 Main CI 与项目要求的定时 workflows 全部 terminal success。

## 7. 批准口径

本 RFC 属**非平凡重构**且横跨三个 bounded context 的 infrastructure 层，按 `CLAUDE.md` §RFC workflow
必须先获用户批准才能进入实现阶段。批准即授权 §3 全部目标与 §6 验收标准；不授权任何 §4 非目标。
