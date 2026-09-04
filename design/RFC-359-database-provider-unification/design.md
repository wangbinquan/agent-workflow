# RFC-359：技术设计

## 1. RFC-294 对齐（CLAUDE.md §RFC workflow 第 8 条）

- **落层**：事务原语与 `DatabaseClient` 属 `platform`（RFC-294 `proposal.md:211` 明列
  `platform` 承担 `persistence/tx`）。各 bounded context 的 `infrastructure` 只实现 ports，
  **不再按 provider 分叉**。bootstrap 唯一装配，且只装配**一份**。
- **本 RFC 承担的演进**：把 provider 从「每个 context 的 infrastructure 里各有两份」上移为
  「platform 里的一份客户端 + 一张方言表」。这是 RFC-294「跨模块只依赖 exact public 合同、
  bootstrap 唯一装配」在持久化面上的兑现——今天 bootstrap 装的是两套。
- **留下的债**：`legacySqlite*` 家族（collaboration 的 clarify 子系统 3,401 行等）在合一后仍是
  「一份实现」，但仍带 `legacySqlite` 命名与 legacy 分层位置。**本 RFC 只做 provider 合一，
  不做这些文件的分层归位**，各自随所属 context 的下一个 RFC 迁。写进 plan §债。
- **偏离项**：见 §9。

## 2. 目标形状

```
platform/persistence/
  databaseClient.ts     —— 唯一的客户端抽象（两个 provider 各一个实现）
  transaction.ts        —— 统一事务原语（§3）
  dialect.ts            —— 闭合方言表（§5），provider 差异的唯一容身处
  writerLease.ts        —— SQLite 单写者租约（§3.2）

modules/<ctx>/infrastructure/
  <name>.ts             —— 一份实现，签名吃 DatabaseClient / Tx，不认识 provider
```

`sqliteX.ts` / `postgresqlX.ts` 成对文件全部消失。bootstrap 里 provider 只出现一次：选哪个
`DatabaseClient` 实现。

## 3. 统一事务原语（本 RFC 的技术核心）

### 3.1 契约

```ts
export interface DatabaseSession {
  /** 写事务。体内只允许 await 数据库操作（见 §3.4 的守卫）。 */
  transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T>
}
```

两个 provider 上语义相同：体内抛错 ⇒ 整笔回滚；正常返回 ⇒ 提交；体内跨事件循环 tick 仍在同一
事务内。

### 3.2 SQLite 实现

```
await writerLease.acquire()          // 进程内单写者，异步互斥
try {
  db.exec('BEGIN IMMEDIATE')         // 预占 writer（RFC-338 AC-2 的既有不变量）
  const r = await body(tx)
  db.exec('COMMIT')
  return r
} catch (e) {
  db.exec('ROLLBACK')
  throw e
} finally {
  writerLease.release()
}
```

**为什么这是安全的**（proposal §3 三组实测）：不再依赖 `bun:sqlite` 的「回调返回即提交」启发式，
事务边界由显式语句划定；单写者租约保证 `BEGIN` 与 `COMMIT` 之间没有第二个写者在同一连接上发语句。

**读连接分离**：事务外的读走既有的只读连接（`platform/persistence/sqlite/readonlySqliteDatabase.ts`），
WAL 下不被写事务阻塞，也不会误入他人事务。

### 3.3 PostgreSQL 实现

沿用既有 `db.transaction(async tx => …)` + `retryPostgresqlSerialization`
（`postgresqlTaskLifecycleTransaction.ts:47-59` 的形状）。PG 侧不需要应用层单写者。

### 3.4 失败模式与护栏

| 失败模式 | 后果 | 护栏 |
| --- | --- | --- |
| 事务体内 await 了**非数据库**的慢操作（网络 / 子进程 / 文件） | SQLite 上独占写者，其余写请求排队；长到超时即雪崩 | **守卫**：事务体内禁止 import 进程 / 网络 / fs 模块；`transaction()` 带可配置软超时并在超时点记结构化诊断（不中断，避免半提交） |
| 事务内嵌套调用 `transaction()` | 单写者租约自死锁 | 用 `AsyncLocalStorage` 检出重入，内层复用外层 `tx`（PG 侧同样复用，不开 savepoint——本仓无 savepoint 语义需求） |
| body 抛错后 `ROLLBACK` 本身失败 | 连接残留在事务中 | `ROLLBACK` 失败即视为连接不可用，标记并重建；不吞错 |
| 有人绕过原语裸调 `db.transaction(async …)` | 回到零原子性 | lint 规则 + 架构守卫禁止裸 `db.transaction(`（AC-5） |

### 3.5 迁移路径

`dbTxSync` 保留为**兼容层**：内部改为调用新原语并把同步体包成 `async`。这样 114 个既有调用点
**不必同时改**，可逐 context 迁移；全部迁完后删除（C-1）。

## 4. 适配器合一的方法

对每一对 `sqliteX.ts` / `postgresqlX.ts`：

1. **取语义正身**：以 SQLite 侧为准（它是产品长出来的那条，且被测试覆盖 90–100%），
   PG 侧的差异逐条判定为「缺陷」或「有意方言」。判定依据是前置对账已列出的清单。
2. **搬进一份实现**：签名从 `DbClient` / `PostgresqlDatabaseClient` 改为 `DatabaseClient`，
   事务改用新原语，方言点改为查 §5 的方言表。
3. **保留两个具名工厂**（`createXForSqlite` / `createXForPostgresql`）**仅做绑定**，直到
   bootstrap 那一侧也收敛；然后连工厂一起删。
4. **每对合一都带**：①合一前后 SQLite 行为逐字对拍；②PG 侧真库执行一次；③被修掉的缺陷各带
   一条先红后绿的回归用例。

## 5. 方言表（provider 差异的唯一容身处）

闭集，逐条带可执行断言 + 两个 provider 各一次真实执行：

| # | 差异 | 来源 |
| --- | --- | --- |
| 1 | NULL 排序（SQLite 视 NULL 最小 / PG 视最大） | `postgresqlNullOrdering.ts`、`rfc349-null-ordering-parity` |
| 2 | `LIKE` 大小写（SQLite ASCII 不敏感 / PG 敏感） | `rfc349-provider-search-case-parity` |
| 3 | `LIKE` 默认转义符（SQLite 无 / PG 是 `\`） | 本次对账 P1-28（**新增**） |
| 4 | 布尔字面量（SQLite 0/1 / PG `boolean`） | `rfc349-boolean-expression-parity` |
| 5 | 裸 SQL 行的数值归一（PG 的 int8 经驱动回来是字符串，drizzle mapper 不参与） | `dfbfb3a91`、`docs/dev-gotchas.md` 第 4 条（**本次修正**） |
| 6 | 驱动错误形状（SQLite message 前缀 / PG SQLSTATE） | 既有 `ALLOWED_DIVERGENCE` |
| 7 | 锁与隔离级别语法 | `withPostgresqlSerializableTaskExecution` |
| 8 | 标量函数 shim（`json_valid` / `json_extract` / `instr` / `unixepoch` …） | `0000_rfc349_baseline.sql:8-29` |

**清单是 exact 的**：新增一条必须显式登记并给理由，清单外不允许 `provider === '<literal>'`。

## 6. 统一启动序列

今天：`cli/start.ts:1570` PG 进永不返回的 `servePostgresqlDaemon`，`:1581` 之后是
`if (provider !== 'sqlite') throw`，于是 `:1953–2256` 整段 boot 恢复 / 屏障 / 播种 PG 不可达。

目标：**一条 boot 序列**，每一步吃 provider-中立的端口。补审已逐条列出 PG 缺的步骤
（boot 恢复四步、skill catalog boot 五项、终态工作区回收策略注册、数字员工模板播种、demo 播种、
融合三步、定时任务载荷治愈、终态维护恢复五项、development-automation 三处）。这些**不是新功能**，
是把既有实现接上——多数 PG 适配器已经写好且已接进 persistence，只是没人调。

## 7. 防复辟守卫（AC-5）

1. **成对文件计数守卫**：`sqliteX.ts` ↔ `postgresqlX.ts` 配对数必须为 0（迁移期按波次下调棘轮）。
2. **裸事务守卫**：`db.transaction(` 只允许出现在 `platform/persistence/transaction.ts`。
3. **provider 分叉账本**：`provider === 'sqlite'` / `'postgresql'` 的出现点是 exact 清单，
   每条带理由；新增即红（沿用既有 `rfc349-provider-completeness` 的账本形态）。
4. **方言表完备性**：§5 每条都有断言且**在真 PG 上执行过**；语料按类型可达派生
   （沿用 `tests/architecture/postgresqlSurface.ts` 的判据，它已经解决了「按文件名前缀取语料会漏」）。
5. **既有 drift 守卫升级**：`rfc349-dual-provider-predicate-drift` 今天按「同名顶层 function」比对，
   153 对里 106 对（69%）零重叠、完全扫不到。合一后该守卫的对象消失，改为守「配对数为 0」。

## 8. 测试策略

- **原子性对拍**（AC-3）：proposal §3 三组实测固化为回归用例，两个 provider 各跑一遍。
- **合一前后对拍**（AC-8）：每对适配器合一时，SQLite 行为逐字对拍（沿用 RFC-357 `rfc311-*-fastpath`
  的对照手法）。
- **真库 lane**（AC-6）：从 RFC-357 的 `rfc357-*` 窄 lane 扩到覆盖统一实现的行为面，进 push CI。
  **判据是返回值，不是 SQL 文本**——脚本化 runtime 只能证明「适配器发出了作者预期的 SQL」。
- **P0 回归**（AC-7）：7 条 P0 各一条先红后绿用例，且修完再跑一次原变异确认转红
  （RFC-287 五轮门沉淀的纪律）。

## 9. 实现偏离（须逐条呈确认）

- **偏离-1**：`dbTxSync` 不立即删除，保留为兼容层直到最后一波。理由：114 个调用点同时改会让
  单个 PR 无法审。代价是过渡期同时存在两条事务入口（但下面是同一个原语）。
- **偏离-2**：SQLite 侧引入**进程内单写者租约**，这是新的运行时机制。理由见 §3.2；
  RFC-351 之后每笔写事务本就 `BEGIN IMMEDIATE` 预占 writer，本质是把隐式串行显式化。
- **偏离-3**：`legacySqlite*` 命名与分层位置**不在本 RFC 处理**（§1「留下的债」）。
