# RFC-359：技术设计

## W12 已落地的装配约束（2026-09-08）

- 物理 task CAS/companion/event 顺序与 committed append 各由一份共享程序解释执行；调用方仍
  持有原同步或异步事务，原同步返回、异步锁位置、nullable/strict miss及提交后发布保持。
  `transactionProgram` 只复用步进机制；public SQLite生命周期入口和未迁移companion继续显式留债。
- filtered task 根页复用原default的去重告警联接，只投影所需匹配列，fam限定页内唯一root集合。
  默认SQL/绑定/结果与原页/游标/筛选计数合同保持，性能提升以原规模双库HTTP P95实测为准。
- 计时后SQL诊断对含写入的CTE只取不执行的计划，普通读查询保留实际ANALYZE；计划模式显式
  入报告，原只读事务、清理与计时样本保持，计划缺失不能用报告complete假装解决。

- 归档查询 store 与维护键值读写各只有一份中立实现；原 provider 工厂退为类型兼容壳，
  保留数值、NULL、游标/文件追加和 archive 事务顺序。测试移到双库但原大语料仍由 hosted 执行。
- Workflow 共享校验只合并实际相同的算法，原入口的 canonicalization 时点、缺失引用排序、
  no-op 分支和事件回调位置保持；不能用共享名义静默改变旧合同。
- PG 借用内部工作区的宿主任务必须沿用 internal 分类，与已有 platform input roster 一致。
  真执行证明从实际租约写入一路经过原 artifact path 查询，再到子进程、task done 与终态观察。
- P0 历史变异保留原阶段并追加 boot/revoked-owner/release 场景，现14阶段，使用真实任务或非空恢复状态。
  原调用遗漏的重建与字面历史函数替换分别记证据，全部以指定失败和前后真实控制判定。
- Workgroup 的规范化、快照、hash、行/修订/详情解码共用纯函数；legacy 的数组 slice 与中立
  数组展开仍各在原边界执行，保留稀疏数组、自定义迭代器及异常语义。共享 codec 不改变 SQL、
  CAS、ID/时钟采样或事务；跨目录残余构造另计，不能据此退役整个 provider adapter。
- AC7 历史变异在独立子进程中替换实际导出，不写回生产源码；原始控制先绿，指定旧行为再红，
  恢复控制再绿。必须同时核对 provider、用例名、具体断言/错误、完成数及源码摘要，setup/import
  失败、跳过、任意 exit 1 或其他断言失败均不算证明。真双库由独立 PG CI job 执行并保存原始日志。
- 完整 TaskDrive 的 dynamicWorkflow 与两 provider runtime participants 构造输入必填；原 legacy
  RunTaskOptions 的可选合同保留。测试的完整工厂通过实际同库四类目录读取构造 validationContext。
- 原始性能基准复用生产请求外壳与真实六域 owner，在计时外构造一次；生产全路由闭合检查仍在原根。
  同源微型 SQLite 模板经真实逻辑迁移初始化 PG 后分别播原五表语料；独立 worker 顺序测九个 HTTP
  场景，以原 floor 分位数逐项比较，完整样本与行数/摘要/代码/机器见证随报告保存。
  归档在两份 HTTP 报告完成后另列；small/weekly 或结构守卫通过不等于 AC11 full 验收通过。

- 同一 bootstrap 作用域内的依赖环用完整端口的词法闭包连接；闭包只在启动完成后的实际调用中求值。
  不再用可空 holder 加第二次 bind 保存 realtime、scheduler、MCP、collaboration 或 development 实例。
- `catalogBinding` / `runtime` 在输入中必有时，memory / digital-employee 的返回类型分别保证 catalog /
  runtime 存在；省略或可选输入仍保留原不完整模块契约，不能用断言把两种类型混在一起。
- WorkStart 闭合必须保持 SQLite HTTP 员工模块与 OS worker 的原实例关系；PG 保持原单实例。
  是否构造过、是否真实调用过、是否在两个 provider 上完成行为验证，继续分开记账。
- 初始会话的迁移窗口来自已经构造的真实 admission。异步 bootstrap 使用 composing/ready/failed
  状态表达生命周期，只在唯一 controller、session 与 router 完成后返回；迁移端口不再外部 bind。
  初始期间的迁移动作明确拒绝，避免自等待及提前读取 controller，初始窗口仍可立即读取。
- resource-package apply journal 使用一份 DatabaseSession 算法，CAS 与外层回滚共享事务；
  SQLite/PG 的资源恢复机制仍保留各自实现，不将 journal 合一误记为整对机制退役。
- 来源终止保持每目标串行；`sourceTerminationTarget` 共用一个可重放事务 atom，生命周期
  CAS、节点/owner/intent 收尾和持久事件共用原子边界，CAS miss 按实际终态赢家出收据。
  clear-closed 首次与重放都只解除 closed fence，不产生停止义务。普通生命周期命令也复用
  同一物理 writer；伴随写失败必须向外传播并整笔回滚，不能误认作生命周期 CAS 冲突。
  两侧原有提交后事件/停止相对 review lock 的位置，以及 SQLite 无 driver 收尾继续保留。
- taskExecutionPersistence 只维护一份按原顺序构造的成员聚合；所选恢复生命周期在原字段处
  注入。continuation pre-drive 的三个参与者共用同一中立客户端，运行流程保持不变。
- classic catalog 由一个完整 bundle 装配，构造期不执行数据库或文件操作；runtimeRegistry
  getter 仍引用同一启动内核，原 appHome 和 restoreMembership 参数保持。
- 资源包持久化回执保持原字段；HTTP 文档转换统一补齐 operationId → opId，首次成功与
  持久化重放使用同一 wire 结果，避免提交成功后响应 schema 失败。
- 需求快照与 mission 引用在一个中立事务中提交；锁定聚合后重读与合并，固定调用 epoch，
  插入/CAS 任一失败均回滚，避免 readiness 并发写后只留孤立快照。
- 维护慢片诊断仅记录当前片最慢 SQL 模板及 process CPU，不推断其属于该片最大事务；
  不改变采样直方图、负载或验收阈值，诊断输出失败不改变工作结果。
- 插件插入与发布 SQL 各只有一份，捕获行 CAS 保留全部 16 列及 NULL 语义；普通仓库与
  legacy/PG 资源包提交都在原外层事务中 await。输入解析、安装时序与调用方错误仍在原层。
- MCP 写入共用 insert/update atom，id 匹配与完整捕获行 CAS 用闭合类型保留各入口原合同；
  会话失效复用原中立实现，提交链全部 await，独立 rename 与时间采样保持。
- runtime 的完整驱动构造必须带齐实际使用的 identityAccess；外层可继承运行选项仍允许省略，
  由持有依赖的 participant 在驱动时补齐。结构类型检查不能替代真实任务执行证据。
- 会话事务重入按根客户端识别；仓库写入保留原客户端以复用事务帧，测试观察未提交行时用 tx，
  不能把 SQLite 单连接下恰好可见的 root 读法搬到 PostgreSQL 连接池。
- 工作流共用行解码与详情/草稿/修订投影；legacy hash 入口先迁移，中立 raw hash 入口保留
  原始输入阶段，不因提取公共函数改变旧版本定义与额外字段的处理。
- 双引擎测试可请求同一 provider 的多个独立真库；默认端口指向第 0 库，迁移/种子流程只
  维护一份。附加库独立重置与清理，不把原来隔离的业务 fixture 合进同一数据库。
- 协作上下文携带由构造输入证明的能力类型；完整路由需要四能力，单项命令/查询只要求所用能力。
  工厂的条件类型对联合输入整体判定，可选或 undefined 不能获得完整能力；phantom 类型不改变
  WeakMap、对象身份及运行诊断。构造合同与实际双引擎执行仍是两层证据。
- Agent 解码共用一份字段/sidecar 投影，normalized 与 stored-json 保留原入口的数据格式合同；
  malformed JSON、NULL、数组 sidecar、字段省略与错误先后不能因提取公共实现而改变。
- Agent 完整写入字段共享一个 encoder；原输入、已解析引用与 prepared frontmatter 分别传入，
  不用对象展开提前求值。legacy 显式空数组与中立省略空 sidecar、稀疏更新字段存在性保持原合同。
- PostgreSQL 重试策略位于 platform/persistence，调用者共用原策略；机制归位不改变重试预算或时序。
- 旧测试夹具从 SQLite 迁到双引擎时，要显式保留原触发器已经生成的行值；不能只复制 insert
  参数而让 PG 以不同初始行进入业务流程。涉及原串 hash 的字段也保留原字节序。
- Event Center 构造参数与其四个实际存储共用中立数据库类型；原装配函数及完整端口保持，
  不能仅因底层实现已合一就推断外层参数也已开放。
- 初始化事件夹具必须等待 cutover 设置写入，再创建 pump/dispatcher 并返回句柄；调用方完整 await。
  原全局清理与工作生命周期保持，不能让 SQLite 同步执行掩盖 PostgreSQL 未完成初始化。
- 原始 fixture 的等价性以当前迁移完成后的实际行证明。0224 已退役 node-run lineage 插入触发器，
  不能照旧迁移文本给直接 node-run seed 增加原本为 NULL 的值；仍在生效的 task 根 lineage 要保留。
- Overview 性能与计划用例分别走各引擎的生产查询：SQLite buildOverview，PG 的五组 owner 查询组合。
  用真库写入后再次计数证明查询活着执行；测量不包含 HTTP daemon，结构阈值与 P95 诊断继续分开。
- provider 文件改名只适用于已经中立的实现；真正重复的实现先合一，必要机制差异保持明确命名与对拍。

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
await new Promise(setImmediate)      // W2-T11d：让出本事件循环任务，事务在干净的任务里开始
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
事务边界由显式语句划定；单写者租约保证 `BEGIN` 与 `COMMIT` 之间没有第二个**统一原语**写者在同一连接上发语句。

**旁观者隔离（W2-T11d，2026-09-05 修订，CI 实撞 `6efee254f`）**：租约管不住过渡期仍存在的 276 处同步
写者（`dbTxSync` 与裸 `db.update(...).run()`）——它们不排队，只要在 `BEGIN` 与 `COMMIT` 之间跑到就落进别人的
事务。`await` 只让渡到微任务队列，而 Bun 在每个宏任务回调之后把微任务队列排空（实测三种形态：immediate /
timer / 嵌套 immediate），所以旁观者能插进来的唯一途径是：**它的续体与事务体的续体排在同一条微任务队列里**。
CI 撞到的正是这个：driver 释放序列在 `registry.release` 唤醒取消路径 / webhook 终态控制之后紧接着开事务，
两边续体交错，旁观者 `dbTxSync` 撞上开着的事务（RFC-268 取消 500、RFC-303 终态控制落成 retryable、
RFC-092 successor 认领撞 `claimed`）。修法是把事务安排在**新的事件循环任务**里开始（`setImmediate`）：被本轮
唤醒的同步写者先跑完，事务体只 await 数据库操作时（bun:sqlite 是同步驱动，drizzle 的 thenable 当场执行），
BEGIN 到 COMMIT 之间没有任何别的上下文能运行。三条守卫：

- 事务体 await 了非数据库操作（跨宏任务）时，旁观者的**任何**语句（不只 `dbTxSync`）由 `db/client.ts`
  `guardForeignStatements` 拦成 `CrossContextTransactionError`（drizzle 包成 `DrizzleError`，守卫错误在 `cause`）；
- 事务自身在 COMMIT 时记一条带 BEGIN 处调用栈的 error 日志（`watchEventLoopYield`）——只记不抛：跨任务的检出
  只能在下一轮事件循环观测，抛会变成时序相关的假红；
- `rfc359-database-transaction.test.ts` 的「旁观者隔离」组把「唤醒 + 立刻开事务」与「微任务链探针不交错」锁住。
  成本：每笔 SQLite 统一事务多一次事件循环让渡（微秒级；持锁时间从 BEGIN 起算，不含等待）。PostgreSQL 会话不变。

**读连接分离**：事务外的读走既有的只读连接（`platform/persistence/sqlite/readonlySqliteDatabase.ts`），
WAL 下不被写事务阻塞，也不会误入他人事务。

**跨进程写锁重试（W4-B1 批 2d 补，批 2g 改为整笔重跑）**：撞 `SQLITE_BUSY` / `SQLITE_BUSY_*` / `SQLITE_LOCKED*`
时按 RFC-111 PR-D 的 `retrySqliteWrite` 判据退避重试（最多三次），重试单位是**整笔事务**（BEGIN → 体 → COMMIT）：
失败的一笔已经 ROLLBACK、没有留下任何效果，事务体又只允许 await 数据库操作，整笔重跑不会重复副作用；其余错误码 fail-fast。进程内写者由租约串行，这条只对付另一个进程
（备份 / vacuum / CLI）正持有写锁、`busy_timeout` 到期或扩展码绕过等待的情形。

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

| 失败模式                                                      | 后果                                                                            | 护栏                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事务体内 await 了**非数据库**的慢操作（网络 / 子进程 / 文件） | SQLite 上独占写者，其余写请求排队；长到超时即雪崩；**且旁观者隔离失效**（§3.2） | **守卫**：旁观者语句拦成 `CrossContextTransactionError`（`guardForeignStatements`）+ 事务 COMMIT 时记带调用栈的 error 日志（`watchEventLoopYield`，已落）；事务体内禁止 import 进程 / 网络 / fs 模块的 lint 与软超时诊断仍是 T12 |
| 事务内嵌套调用 `transaction()`                                | 单写者租约自死锁                                                                | 用 `AsyncLocalStorage` 检出重入，内层复用外层 `tx`（PG 侧同样复用，不开 savepoint——本仓无 savepoint 语义需求）                                                                                                                   |
| body 抛错后 `ROLLBACK` 本身失败                               | 连接残留在事务中                                                                | `ROLLBACK` 失败即视为连接不可用，标记并重建；不吞错                                                                                                                                                                              |
| 有人绕过原语裸调 `db.transaction(async …)`                    | 回到零原子性                                                                    | lint 规则 + 架构守卫禁止裸 `db.transaction(`（AC-5）                                                                                                                                                                             |

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
  lockAggregateRoot(tx, table, id): SQL // PG: FOR UPDATE            SQLite: no-op（已独占）
  claimRows(tx, table, where, limit): SQL // PG: FOR UPDATE SKIP LOCKED  SQLite: 普通 SELECT
  advisoryLock(tx, key): Promise<void> // PG: pg_advisory_xact_lock  SQLite: no-op
  readonly isolation: 'read-committed' | 'exclusive'
  // JSON
  jsonExtract(col, path): SQL // PG: JSONB ->> / #>>        SQLite: json_extract
  jsonContains(col, value): SQL // PG: @>（走 GIN）           SQLite: json_each 展开
  // 批量
  readonly batchInsertMax: number // PG 大批；SQLite 受 SQLITE_MAX_VARIABLE_NUMBER 约束
  // 方言语义（既有三条 parity 守卫 + 本轮新增两条）
  orderNullsLast(col): SQL // PG: NULLS LAST             SQLite: 默认即最后（DESC）
  likeCaseInsensitive(col, pattern): SQL // PG: ILIKE                  SQLite: LIKE（ASCII 不敏感）
  likeEscape(pattern): { pattern; escape } // 两侧都显式带 ESCAPE，消灭默认转义符差异
  numericFromRawRow(v): number // PG: int8 回字符串须归一   SQLite: 原样
  classifyError(e): 'unique-violation' | 'serialization' | 'other' // PG 看 errno 的 SQLSTATE
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

| #   | 守卫                                                                                                                                                                                                                | 挡的是哪类失效（对账里的 A/B/C）                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **provider 命名的文件只允许存在于 `platform/persistence/`**（`sqlite*` / `postgresql*` 在其他任何目录出现即红；迁移期按波次下调棘轮到 0）                                                                           | A 语义重推                                                                                 |
| 2   | **`provider === '<literal>'` 只允许出现在 `platform/persistence/`**，其余全仓 exact 账本为空                                                                                                                        | A                                                                                          |
| 3   | **组合根必须是全量的**：`cli/` 与 `*/composition*` 下禁止任何 `throw new Error('*-not-bound')` / 晚绑定 holder；依赖在构造时全量传入                                                                                | B 装配缺口（`DeferredTaskQuestionDispatcherBinding` 这个形状正是穿过既有完整性守卫的口子） |
| 4   | **启动序列只有一个调用方**：boot 序列是一个吃 provider-中立端口的函数，守卫断言它恰有一个调用点且 `cli/start.ts` 无 provider 执行分支                                                                               | B                                                                                          |
| 5   | **能力矩阵每项双引擎实测**：矩阵条目 exact，每条在两个真引擎上各执行一次                                                                                                                                            | C 方言陷阱                                                                                 |
| 6   | **覆盖率对等棘轮（过渡期）**：同一 port 两侧行覆盖率差超过阈值即红。今天是 SQLite 100% vs PG 2.38%，这一条能钉住全部 12 条 P0——它们无一例外落在 PG 覆盖率个位数的 port 上。合一后自然消失（一份实现只有一个数）     | A + B                                                                                      |
| 7   | **全量 backend 行为套件在真 PostgreSQL 上跑，在 push 上跑**（不是窄 lane、不是每周 cron）。这是最终 oracle：脚本化 runtime 只能证明「适配器发出了作者预期的 SQL」，证明不了 int8 回字符串，更证明不了整个子系统缺失 | A + B + C                                                                                  |

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

**勘误（W8 实测，2026-09-07）：上一段的「读—改—写必须先 `lockAggregateRoot`」不是充分条件。**
当事务是 **SERIALIZABLE**（`runResourceCatalogTransaction` 在 PG 上就是）时，快照在**第一条语句**
即冻结；`FOR UPDATE` 只让输家**排队等锁**，等到之后**不重取快照**。于是「读 `max(seq)` → 写
`seq+1` 进唯一键」这一子类，加了行锁**照样** `23505`——实测给 session 行加锁后
`mcp_runtime_test_events` 仍稳定重复键。行锁能救 `acceptMessage` 是因为那里聚合根行本身被并发
UPDATE、SSI 抛 40001 触发**整段重放**；**救它的是重放，不是锁**。

因此纪律补一条：**单聚合的读—改—写，判据是「输家会不会重新读一遍」**，不是「有没有加锁」。
序号分配 / 版本号自增这类形状要走**新事务重放**——本仓的
`runCatalogTransactionRetryingUniqueViolations`（资源目录事务 + `classifyError === 'unique-violation'`
时有界重试），新事务取新快照，前置检查这次才会命中，收敛到 SQLite 的结果。

**由此暴露出的一整类 provider 分叉（W8 普查，见 §10.1.1）**：「先查存在、再插入唯一键表」的写法，
SQLite 上前置检查恒命中、返回域内 4xx；PG 上两个用户并发时前置检查双双落空、唯一键抛 23505，
用户拿到 **500**。这正是本 RFC 要消灭的「一个引擎好一个引擎不好」。

#### 10.1.1 唯一键未归一普查（W8）—— 含一次**判据方向被实测推翻**

**先记结论：本节初稿列的 Tier A 四处，逐处实测全部不可达，四条判断错法各不相同。**
每处都用确定性并发（`Promise.allSettled` 打同一聚合，不靠墙钟）在两个引擎上跑够轮数，
并用变异反证「真正兜住它的是什么」：

| 站点                               | 兜住它的机制                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryWorkspaceStore.ts` 建组 | 读**之前**就有 `engineOf(tx).advisoryLock(tx, 'source-control:repository-groups')`。opener 是 `.transaction()` = READ COMMITTED，**每条语句取新快照**，输家等到锁后那条 SELECT 就看得见赢家   |
| 同文件改名                         | 根本不是本类形状——走 `update` 不是 `insert`，普查判据不覆盖；何况同一把 advisory lock + 全图 `expectedGraphVersions` CAS 双重挡着                                                             |
| `taskContinuationAdmission.ts`     | opener 是 `.serializable()`；PG 的 SSI 先给输家 **40001**，而 `serializable()` 的重试单位是**整笔事务**，重跑取新快照才读得到活跃 intent。**救它的是重放，不是锁**（与 §10.1 勘误同一条机制） |
| `humanGateOpenParticipant.ts`      | 第二笔 open 在上游 `humanGateOperationJournal.beginTx` 就被挡下（先 `lockAggregateRoot(tasks)` 再查活跃操作）                                                                                 |
| `legacy/skillVersion.ts`           | 上游 `stageSkillVersion → beginOperation → acquireOpLocks` 先抢 `skill_operation_locks` 的排他行，PK 冲突**已经**归一成 409——初稿写的「归一在另一条路径上」是错的，它就在同一条路径的**上游** |

**由此得到一条比原判据锋利得多的规律（实测，20/20 反证）**：

> **SERIALIZABLE 能不能兜住「先查存在、再插唯一键」，取决于两笔事务有没有读过它们要插的那张表。**
> 那次读留下的 **SIREAD 谓词锁**才让插入成为 SSI 可检测的读写冲突。把前置读换成读**另一张**表，
> 同一段代码在 PG 上 **20/20 全红**。

**推论（判据方向被推翻）**：普查判据「同作用域先读同一张表 → 插同一张表」**恰好筛出的是
SERIALIZABLE 下安全的那一支**。真正危险的是「读 A 表算序号、插 B 表」——
`mcpRuntimeTestPersistence.appendEvent` 正是这种，而它**不满足**该判据。
所以这条守卫的实际预言力集中在 **READ COMMITTED opener + 读前无锁**那一档，
账本里为此额外输出 `opener` / `openerSerializes` / `serializedBeforeRead` 三个**诊断**字段
（不进判据），红了能一眼看出落在哪一档。

**Tier B 事件骨干：安全。** `append.ts` 的 `reserveAggregateSequence` 在读 heads **之前**取
per-aggregate advisory lock（`producer:family:kind:id`）；全新聚合上两条并发追加，
两个引擎 × 两种 opener 都拿到 seq 1/2。`sqliteStore.ts` 那份句柄类型是 `DbTxSync`，PG 上不执行。
变异实证：删掉那把 advisory lock，READ COMMITTED 下 PG 25/25 红，**SERIALIZABLE 下仍绿**（SSI 兜住）。

**普查数字以守卫实算为准（初稿四个数全部不对）**：带唯一约束的表 **124**（不是 125）；
事务内 insert 点（排除 `onConflictDo*`）**141**（不是 180）；其中无归一 **105**（不是 77）；
其中同作用域先读同表 **40 处 / 21 个文件**（不是 23）。账本
`UNNORMALIZED_UNIQUE_INSERT_DEBT` 起始 = 21 行 / 40 处，逐条 why + removeWhen，
并注明四类假阳性来源：归一/串行化住在调用方、锁在别的函数里、单写者播种、
同步事务面 `dbTxSync`（PG 上不可达）。

**这一节留作教训**：初稿是从两处**真实**缺陷（`mcpRuntimeTestPersistence` 的 `appendEvent` /
`create`，已修）反推出的判据，反推错了方向——**从个例归纳判据时，要先问「这个例子属于哪一档」，
再问「这一档的边界是什么」**。少了后一问，判据会稳稳地筛出安全的那一支。

### 10.2 引擎优势必须真的用上

| 优势           | 今天                                                                                     | 目标                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 多写并发       | PG 侧部分路径用 SERIALIZABLE，小表上冲突率 81.2%                                         | READ COMMITTED + 行锁，默认                                                                                                      |
| JSONB + GIN    | JSON 列按 SQLite 的 `text` 投影到 PG，查询走 `json_extract` shim（函数调用，走不了索引） | DDL 投影把 JSON 列渲染成 JSONB，热查询列建 GIN；矩阵的 `jsonExtract`/`jsonContains` 渲染成 `->>` / `@>`                          |
| 批量写         | 多处逐行 INSERT                                                                          | 矩阵给出 `batchInsertMax`，实现按批                                                                                              |
| 索引与执行计划 | 索引从 SQLite 投影，未按 PG 计划器审过                                                   | RFC-311 基准库在 PG 上跑 `EXPLAIN (ANALYZE, BUFFERS)`，逐热查询审计划；PG 独有的索引（partial + expression + GIN）经能力矩阵声明 |
| 连接池         | `poolMax` 可配                                                                           | 读请求走池并行、写事务不串行——已由 §3.3 保证，性能守卫锁住                                                                       |

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
  test('…', async () => {
    /* 同一段断言，跑两遍 */
  })
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

| #   | 守卫                                                                                                                                      | 挡什么                        | 落在哪                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| 1   | provider 命名文件只许在 `platform/persistence/`（棘轮 → 0）                                                                               | A 语义重推                    | W5-T17                       |
| 2   | `provider === '<literal>'` 只许在 `platform/persistence/`                                                                                 | A                             | W5-T19                       |
| 3   | 组合根全量：禁 `*-not-bound` / 晚绑定 holder                                                                                              | B 装配缺口                    | W5-T19b                      |
| 4   | 启动序列恰一个调用方；`cli/start.ts` 无 provider 执行分支                                                                                 | B                             | W5-T19c                      |
| 5   | 能力矩阵每项双引擎真实执行断言（本提交已落第一版）                                                                                        | C 方言陷阱                    | W2-T11b ✅                   |
| 6   | **测试不得写死引擎**：`createInMemoryDb(` 在 harness 之外的出现次数棘轮 1,882 → 0；测试内按 provider 分叉必须经 `capabilities` 且计数入账 | A+B+C 的验证盲区              | W5-T19f                      |
| 7   | 覆盖率对等棘轮：同一 port 两侧行覆盖率差超阈值即红（过渡期；今天能钉住全部 12 条 P0）                                                     | A+B                           | W5-T19d                      |
| 8   | 执行链取证：两个引擎上各起一个任务跑到 done，进 push CI 的 e2e                                                                            | B（RFC-349 验收漏掉的那一环） | W5-T21b                      |
| 9   | 性能守卫双引擎，PG 基线不劣于 SQLite，一侧变慢即红                                                                                        | 优化只落一侧                  | W6-T27                       |
| 10  | ~~schema 投影补触发器维度~~ → **改判**：`insert(tasks)` 三列完整性守卫                                                                    | 结构漂移                      | W7（见下「第 10 条的改判」） |
| 11  | 全量 backend 套件在真 PG 上、在 push 上跑（§11.2）                                                                                        | 最终 oracle                   | W5-T21 ✅                    |

#### 实际建成的守卫（W5–W7 落地后，超出原计划 11 条）

原表是**计划**；下面是 `packages/backend/tests/architecture/rfc359-*.test.ts` 的**实际清单**（18 条），
按失效类归位。计划里没有、实测后补上的用 ➕ 标出——它们都是「对账时才发现这一类会漏」的产物。

| 守卫文件                                        | 挡什么                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `rfc359-w5-t17-provider-file-location`          | provider 命名文件外溢（棘轮 → 0）                                                                           |
| `rfc359-w5-t19-provider-branch`                 | `provider === '<literal>'` 执行分叉                                                                         |
| `rfc359-w5-t19b-composition-root-complete`      | 装配缺口（`*-not-bound` / `not-composed`）                                                                  |
| `rfc359-w5-t19c-startup-sequence`               | 启动序列再分叉                                                                                              |
| `rfc359-w5-t19d-coverage-parity`                | 同一端口两侧覆盖倒挂                                                                                        |
| `rfc359-w5-t19f-test-engine-hardcoding`         | 测试写死引擎（➕ W7 补上 `new Database(` 这个后门：此前只数 `createInMemoryDb(`，绕过它的 95 处完全在网外） |
| `rfc359-w5-t19f-toplevel-column-capture`        | ➕ 模块顶层常量捕获列、绕过 provider 投影                                                                   |
| `rfc359-w5-t19g-schema-contract-reconciliation` | ➕ 迁移 DDL 与 drizzle 声明的逐项对账（**PG 缺哪些保护**）                                                  |
| `rfc359-w5-t20-dialect-completeness`            | 方言点未声明（函数词汇闭集，判据是闭集不是黑名单）                                                          |
| `rfc359-w5-t18-bare-transaction`                | ➕ 裸 `db.transaction(`（**不可重入**，外层回滚带不走）                                                     |
| `rfc359-w5-provider-pair-conformance`           | ➕ 成对适配器的合一进度 + 对拍覆盖状态位                                                                    |
| `rfc359-w5-adapter-production-consumer`         | ➕ 零生产消费者的适配器（摆设）                                                                             |
| `rfc359-w5-provider-runtime-exercised`          | ➕ 组合根「只装配、从没被构造过」                                                                           |
| `rfc359-w5-dual-engine-predicate-gaps`          | ➕ 「一侧有校验、另一侧没有」的具名缺口（**补上了也红**，强制销账）                                         |
| `rfc359-w5-artifact-format-portability`         | ➕ 落盘工件格式两侧不互通                                                                                   |
| `rfc359-sync-transaction-highwater`             | ➕ 同步事务面（`dbTxSync`）棘轮                                                                             |
| `rfc359-w6-t28-read-modify-write`               | ➕ 读—改—写中间不锁的形状清单                                                                               |
| `rfc359-w7-task-insert-lineage-completeness`    | ➕ `insert(tasks)` 的血缘 / 启动来源三列完整性                                                              |

另有 RFC-349 遗留的 provider 守卫家族 155 条（`tests/rfc349-*.test.ts`）与本表互补：
本表管**结构**（谁允许存在），那一族管**行为**（同一段 SQL 两侧跑出同一个结果）。

#### 第 10 条的改判（W7，有实测依据）

原计划要「给 PostgreSQL 的 schema 投影补上触发器维度」。**实测后不做**：
活库直查确认 PG 侧非内部触发器数为 **0**，SQLite 侧那 8 个里与功能相关的三个
（`rfc328_*_lineage_after_insert`、`trg_tasks_launch_origin_inherit_child`）都是
`WHEN … IS NULL` 的**兜底填充**，而 AST 清点确认全仓**四个** `insert(tasks)` 站点**全部**
显式提供 `executionLineageId` / `lineageSlotPathJson` / `launchOrigin` —— 触发条件在任何生产
路径上都不成立。

给 PG 补触发器等于给同一条不变量做**第二份实现**（且两方言 DDL 写法不同、必然会漂），
与本 RFC 的方向相反。**正解是让不变量留在唯一的地方（写入方），用守卫钉住每个写入点都遵守**
—— 即上表最后一条。残余风险（将来新增一条子任务插入路径而忘了写这三列，SQLite 会被触发器
悄悄救回来、PG 不会）由该守卫的 exact 账本挡住。

**判定标准不变**：一个新工程师加一个功能，能不能不小心让它只在一个 provider 上工作？11 条守卫
下的答案应当是——他写的测试自动跑两遍（6/11），他写的实现不能提 provider 名（1/2），他装的东西
不能是空占位符（3），他漏装的东西启动序列会报（4），他碰到的引擎差异只能进矩阵（5），他改坏的
性能一侧变慢即红（9）。**每一条都是编译错误或 CI 红，没有一条靠人自觉。**
