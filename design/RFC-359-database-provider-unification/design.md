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

### 3.3 PostgreSQL 实现（并发优先，绝不继承 SQLite 的单写者）

- 沿用驱动自带的异步事务，**不取写者租约**：PG 每笔事务一条独立连接，多写并发是它的核心优势，
  一份实现不能把 SQLite 的串行化带给它。
- **默认隔离级别 READ COMMITTED + 聚合根行锁**，不是 SERIALIZABLE。依据是本仓自己的实测
  （`docs/dev-gotchas.md` 第 6 条）：小表上 SERIALIZABLE 的 predicate lock 是索引页粒度，8 并发
  满速冲突率 81.2%、重试预算耗尽逃逸 234 次；换成 READ COMMITTED + 聚合根 `FOR UPDATE` 后 0%。
  SERIALIZABLE + `retryPostgresqlSerialization` 保留为**显式 opt-in**（`session.serializable(…)`），
  只给确实需要谓词级隔离的少数路径。
- 行锁由能力矩阵渲染（§5）：一份实现写 `capabilities.lockAggregateRoot(tx, table, id)`，
  PG 渲染成 `SELECT … FOR UPDATE`，SQLite 渲染成 no-op（`BEGIN IMMEDIATE` 下本就独占）。

### 3.4 失败模式与护栏

| 失败模式 | 后果 | 护栏 |
| --- | --- | --- |
| 事务体内 await 了**非数据库**的慢操作（网络 / 子进程 / 文件） | SQLite 上独占写者，其余写请求排队；长到超时即雪崩 | **守卫**：事务体内禁止 import 进程 / 网络 / fs 模块；`transaction()` 带可配置软超时并在超时点记结构化诊断（不中断，避免半提交） |
| 事务内嵌套调用 `transaction()` | 单写者租约自死锁 | 用 `AsyncLocalStorage` 检出重入，内层复用外层 `tx`（PG 侧同样复用，不开 savepoint——本仓无 savepoint 语义需求） |
| body 抛错后 `ROLLBACK` 本身失败 | 连接残留在事务中 | `ROLLBACK` 失败即视为连接不可用，标记并重建；不吞错 |
| 有人绕过原语裸调 `db.transaction(async …)` | 回到零原子性 | lint 规则 + 架构守卫禁止裸 `db.transaction(`（AC-5） |

### 3.5 迁移路径（**修订**：`dbTxSync` 做不成兼容层）

原稿写「`dbTxSync` 改为兼容层，114 个调用点零改动」——**做不到，是我写错了**：`dbTxSync` 是同步的
（返回 `T` 不是 `Promise<T>`），转调异步原语必然改返回类型，114 个调用点全部要动，还会破坏它能在
同步上下文里嵌套的性质。

正确形态：**逐 context 迁移调用点**——每个 context 把自己的 `dbTxSync` 调用换成
`session.transaction(async tx => …)`，换完那个 context 的成对适配器就能合一。这与 W4 是同一件事，
不是它的前置。过渡期两套机制共存的唯一危险形态（旁观者写入被静默卷入并回滚）已由
`db/transactionScope.ts` 的跨上下文守卫堵死（`88b9a5940`）。`dbTxSync` 在调用点归零时删除（C-1）。

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

## 5. 能力矩阵（provider 差异的唯一容身处；原「方言表」修订）

**修订为能力矩阵**。原稿是「差异清单」——只回答「两边哪里不一样」；它满足「不分叉」但满足不了
「PG 最高性能」：按差异清单写出来的一份实现是最小公分母，PG 拿不到行锁 / `SKIP LOCKED` / JSONB
这些它独有的最优路径。

**原则：一份实现按「能力」提需求，边界按引擎渲染最优 SQL；实现里永远不出现 provider 名。**
这条原则本仓在别处已经立过（`docs/audit-backlog.md`：「driver 不得按 provider/OS 分叉，要按能力
区分」）。

```ts
// platform/persistence/capabilities.ts —— 每个 provider 一份实现，是本 RFC 允许 provider 分叉的唯一地方之一
export interface EngineCapabilities {
  // 并发与锁
  lockAggregateRoot(tx, table, id): SQL        // PG: FOR UPDATE            SQLite: no-op（已独占）
  claimRows(tx, table, where, limit): SQL      // PG: FOR UPDATE SKIP LOCKED  SQLite: 普通 SELECT
  advisoryLock(tx, key): Promise<void>         // PG: pg_advisory_xact_lock  SQLite: no-op
  readonly isolation: 'read-committed' | 'exclusive'
  // JSON
  jsonExtract(col, path): SQL                  // PG: JSONB ->> / #>>        SQLite: json_extract
  jsonContains(col, value): SQL                // PG: @>（走 GIN）           SQLite: json_each 展开
  // 批量
  readonly batchInsertMax: number              // PG 大批；SQLite 受 SQLITE_MAX_VARIABLE_NUMBER 约束
  // 方言语义（既有三条 parity 守卫 + 本轮新增两条）
  orderNullsLast(col): SQL                     // PG: NULLS LAST             SQLite: 默认即最后（DESC）
  likeCaseInsensitive(col, pattern): SQL       // PG: ILIKE                  SQLite: LIKE（ASCII 不敏感）
  likeEscape(pattern): { pattern; escape }     // 两侧都显式带 ESCAPE，消灭默认转义符差异
  numericFromRawRow(v): number                 // PG: int8 回字符串须归一   SQLite: 原样
  classifyError(e): 'unique-violation' | 'serialization' | 'other'  // PG 看 errno 的 SQLSTATE
}
```

**闭集纪律**：矩阵是 exact 的——每一项在两个引擎上各有一次**真实执行**的断言；新增一项必须同时
给出两侧渲染与两侧测试。实现层如果发现矩阵缺一项，正确动作是**给矩阵加一项**，不是在实现里写
`if (provider === …)`（§7 守卫会红）。

**既有资产直接入矩阵**：`postgresqlNullOrdering.ts`、三条 parity 守卫、`postgresqlSerializationRetry.ts`
的 `errno` 判据、RFC-357 `taskListPage/projection.ts` 的 `numeric*` 归一、`0000_rfc349_baseline.sql`
的标量函数 shim。它们今天散在各处，矩阵把它们收成一个有名字的对象。

## 6. 统一启动序列

今天：`cli/start.ts:1570` PG 进永不返回的 `servePostgresqlDaemon`，`:1581` 之后是
`if (provider !== 'sqlite') throw`，于是 `:1953–2256` 整段 boot 恢复 / 屏障 / 播种 PG 不可达。

目标：**一条 boot 序列**，每一步吃 provider-中立的端口。补审已逐条列出 PG 缺的步骤
（boot 恢复四步、skill catalog boot 五项、终态工作区回收策略注册、数字员工模板播种、demo 播种、
融合三步、定时任务载荷治愈、终态维护恢复五项、development-automation 三处）。这些**不是新功能**，
是把既有实现接上——多数 PG 适配器已经写好且已接进 persistence，只是没人调。

## 7. 防复辟守卫（AC-5）

「以后不要再出现只能一种数据库可用」不能靠人自觉，要靠**结构上做不到**。判断标准：
**一个新工程师加一个功能，能不能不小心让它只在一个 provider 上工作？** 今天太容易了——写个适配器、
忘了在 PG 组合根传一个参数，就是一条 P0。下面七条守卫的目标是把这件事变成编译错误或 CI 红。

| # | 守卫 | 挡的是哪类失效（对账里的 A/B/C） |
| --- | --- | --- |
| 1 | **provider 命名的文件只允许存在于 `platform/persistence/`**（`sqlite*` / `postgresql*` 在其他任何目录出现即红；迁移期按波次下调棘轮到 0） | A 语义重推 |
| 2 | **`provider === '<literal>'` 只允许出现在 `platform/persistence/`**，其余全仓 exact 账本为空 | A |
| 3 | **组合根必须是全量的**：`cli/` 与 `*/composition*` 下禁止任何 `throw new Error('*-not-bound')` / 晚绑定 holder；依赖在构造时全量传入 | B 装配缺口（`DeferredTaskQuestionDispatcherBinding` 这个形状正是穿过既有完整性守卫的口子） |
| 4 | **启动序列只有一个调用方**：boot 序列是一个吃 provider-中立端口的函数，守卫断言它恰有一个调用点且 `cli/start.ts` 无 provider 执行分支 | B |
| 5 | **能力矩阵每项双引擎实测**：矩阵条目 exact，每条在两个真引擎上各执行一次 | C 方言陷阱 |
| 6 | **覆盖率对等棘轮（过渡期）**：同一 port 两侧行覆盖率差超过阈值即红。今天是 SQLite 100% vs PG 2.38%，这一条能钉住全部 12 条 P0——它们无一例外落在 PG 覆盖率个位数的 port 上。合一后自然消失（一份实现只有一个数） | A + B |
| 7 | **全量 backend 行为套件在真 PostgreSQL 上跑，在 push 上跑**（不是窄 lane、不是每周 cron）。这是最终 oracle：脚本化 runtime 只能证明「适配器发出了作者预期的 SQL」，证明不了 int8 回字符串，更证明不了整个子系统缺失 | A + B + C |

第 7 条有代价：backend CI 时间约翻倍。**这是「以后不再出现」的价格**，不打折。前提是测试 harness
按 provider 参数化（今天 `createInMemoryDb(MIGRATIONS)` 把 SQLite 写死在每个测试里），见 §8。

既有的 `rfc349-dual-provider-predicate-drift`（按同名顶层函数比对，69% 盲区）在合一后对象消失，
由第 1 条替代；`rfc349-provider-completeness` 保留但补第 3 条堵住占位符穿透。

## 8. 测试策略

- **harness 按 provider 参数化**（第 7 条守卫的前提）：新增 `tests/helpers/eachProvider.ts`——
  `describeEachProvider(name, (ctx) => …)` 在 SQLite 上用内存库、在 PG 上用 CI 服务容器（无 URL 时
  显式 skip 并入 `test-suite-policy` 账本，且 PG lane 有 grep 保证「有库时必跑」——沿用 RFC-357
  PR-2 的做法）。存量测试逐 context 迁进 harness，与 W4 同批。

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

## 10. PostgreSQL 最高性能（用户硬要求）

「一份实现」与「PG 最高性能」的拉扯，在 §5 能力矩阵这一层化解。这一节写清一份实现**怎么写**
才能让 PG 拿到它该有的性能，以及怎么证明。

### 10.1 写法纪律：并发优先

一份实现必须按**两个引擎里更弱的隔离**写——也就是按 PG 的多写并发写，而不是按 SQLite 的独占写。
具体：读—改—写必须先 `lockAggregateRoot`（PG 渲染 `FOR UPDATE`，SQLite no-op）；队列式认领必须走
`claimRows`（PG 渲染 `FOR UPDATE SKIP LOCKED`）；跨进程协调走 `advisoryLock`。
**反面**：任何「读出来判断再写回、中间不锁」的形状在 SQLite 上碰巧正确（独占）、在 PG 上就是竞态——
这类代码今天在 SQLite 侧存在，合一时必须改成并发正确的形状，而不是原样搬。

### 10.2 引擎优势必须真的用上

| 优势 | 今天 | 目标 |
| --- | --- | --- |
| 多写并发 | PG 侧部分路径用 SERIALIZABLE，小表上冲突率 81.2% | READ COMMITTED + 行锁，默认 |
| JSONB + GIN | JSON 列按 SQLite 的 `text` 投影到 PG，查询走 `json_extract` shim（函数调用，走不了索引） | DDL 投影把 JSON 列渲染成 JSONB，热查询列建 GIN；矩阵的 `jsonExtract`/`jsonContains` 渲染成 `->>` / `@>` |
| 批量写 | 多处逐行 INSERT | 矩阵给出 `batchInsertMax`，实现按批 |
| 索引与执行计划 | 索引从 SQLite 投影，未按 PG 计划器审过 | RFC-311 基准库在 PG 上跑 `EXPLAIN (ANALYZE, BUFFERS)`，逐热查询审计划；PG 独有的索引（partial + expression + GIN）经能力矩阵声明 |
| 连接池 | `poolMax` 可配 | 读请求走池并行、写事务不串行——已由 §3.3 保证，性能守卫锁住 |

### 10.3 证明：性能守卫双引擎

今天 5 个性能守卫**全部只构造 SQLite**，RFC-311 的验收（P95 < 150ms 等）也只在 SQLite 上取过。
目标：
- 同一套 RFC-311 基准库（10 万任务 / 300 万 node_runs / 千万级事件）在**两个引擎**上各跑一遍，
  各端点 P95 分别有基线；**PG 的基线不得劣于 SQLite**（AC-11）。
- `rfc311-perf-guards` 等 5 个守卫改为 `describeEachProvider`。
- 性能回归与功能回归同等对待：一侧变慢即红。

### 10.4 不做的事

- 不为 PG 写第二份「快路径」实现——那是分叉。所有优化都经能力矩阵表达。
- 不给 SQLite 加 PG 才有的东西的模拟——SQLite 侧渲染成它的最优形态或 no-op 即可。

## 11. 质量防护与架构防护总纲（用户 2026-09-04 追加：新增功能**天然**要验证到两种数据库）

「天然」是这一节的判据：**一个新功能，什么都不多做，就已经在两个引擎上被验证了；只在一个引擎上
验证的，是要登记理由的例外。** 今天正好相反——`createInMemoryDb(MIGRATIONS)` 在 816 个测试文件里
出现 1,882 次，SQLite 是缺省，PG 是 `env ? test : test.skip` 的可选项，没有 URL 就静默跳过、绿着骗人。
本 RFC 自己 T11b 的第一版也犯了这个错（`pgTest = env ? test : test.skip`），在这里改正。

### 11.1 测试 harness：双引擎是缺省

```ts
// tests/helpers/eachProvider.ts
describeEachProvider('memory catalog', ({ session, capabilities, db }) => {
  test('…', async () => { /* 同一段断言，跑两遍 */ })
})
```

- `describeEachProvider` 把 body 各跑一遍：SQLite 用内存库；PostgreSQL 用 CI 服务容器里**按测试文件
  隔离的 schema**（`create schema t_<hash>` + 迁移基线），互不串扰，可并行。
- **PG 侧不是 skip 而是 fail**：URL 缺失即整个 describe 红，除非进程显式声明
  `AW_TEST_PROVIDERS=sqlite`（本地开发快速迭代用）。CI 永远不设它。「无库则跳过」这个形态被禁掉，
  因为它正是 12 条 P0 能穿过验收的机制。
- body 拿到的是 `DatabaseSession` + `EngineCapabilities` + provider-中立客户端；**拿不到 provider 名**。
  测试要按引擎分叉时只能走 `capabilities`（例如 `capabilities.isolation === 'exclusive'` 时跳过一条
  并发断言），并且分叉本身被计数（§11.3 守卫 6）。

### 11.2 CI：真 PostgreSQL 是 backend 测试的默认环境，不是一条 lane

今天 `test-backend-postgresql` 是独立窄 lane（`services: postgres:17`，只跑 `rfc357-*`）。目标：
- **四个 backend 分片各自带 `services: postgres:17`**，`AW_TEST_PG_URL` 对每个分片可用；
  `describeEachProvider` 的 PG 半边在每个分片里跑。窄 lane 退役。
- 分片时长上涨由两件事对冲：per-file schema 隔离让 PG 半边可并行；W4 合一后适配器测试数减半。
  实测数字在 W5-T21 落地时写回 proposal §6。
- `postgresql-evidence.yml`（周跑规模 / 迁移 / 崩溃取证）保留，分工不变；但它的
  `prepareSoakDataset` 不再把在飞任务归一成 `done`——新增「起任务 → 进 running → 跑完」的执行链
  取证，在两个引擎上各一遍（§11.3 守卫 8）。

### 11.3 守卫全表（架构 + 质量，按失效类对位）

| # | 守卫 | 挡什么 | 落在哪 |
| --- | --- | --- | --- |
| 1 | provider 命名文件只许在 `platform/persistence/`（棘轮 → 0） | A 语义重推 | W5-T17 |
| 2 | `provider === '<literal>'` 只许在 `platform/persistence/` | A | W5-T19 |
| 3 | 组合根全量：禁 `*-not-bound` / 晚绑定 holder | B 装配缺口 | W5-T19b |
| 4 | 启动序列恰一个调用方；`cli/start.ts` 无 provider 执行分支 | B | W5-T19c |
| 5 | 能力矩阵每项双引擎真实执行断言（本提交已落第一版） | C 方言陷阱 | W2-T11b ✅ |
| 6 | **测试不得写死引擎**：`createInMemoryDb(` 在 harness 之外的出现次数棘轮 1,882 → 0；测试内按 provider 分叉必须经 `capabilities` 且计数入账 | A+B+C 的验证盲区 | W5-T19f |
| 7 | 覆盖率对等棘轮：同一 port 两侧行覆盖率差超阈值即红（过渡期；今天能钉住全部 12 条 P0） | A+B | W5-T19d |
| 8 | 执行链取证：两个引擎上各起一个任务跑到 done，进 push CI 的 e2e | B（RFC-349 验收漏掉的那一环） | W5-T21b |
| 9 | 性能守卫双引擎，PG 基线不劣于 SQLite，一侧变慢即红 | 优化只落一侧 | W6-T27 |
| 10 | schema 投影补触发器维度，投影完整性有断言 | 结构漂移 | W3-T16b |
| 11 | 全量 backend 套件在真 PG 上、在 push 上跑（§11.2） | 最终 oracle | W5-T21 |

**判定标准不变**：一个新工程师加一个功能，能不能不小心让它只在一个 provider 上工作？11 条守卫
下的答案应当是——他写的测试自动跑两遍（6/11），他写的实现不能提 provider 名（1/2），他装的东西
不能是空占位符（3），他漏装的东西启动序列会报（4），他碰到的引擎差异只能进矩阵（5），他改坏的
性能一侧变慢即红（9）。**每一条都是编译错误或 CI 红，没有一条靠人自觉。**
