# RFC-359 — 数据库 provider 统一抽象：一份实现，provider 只存在于客户端

- 状态：**Draft（2026-09-04，待用户批准）**
- current-source pin：`01e4b1b7b`
- 前置事实源：[`design/dual-provider-parity-audit-2026-09-04.md`](../dual-provider-parity-audit-2026-09-04.md)（153 对配对适配器 + 163 个无配对 PG 面文件的全量对账）
- 依赖：RFC-093（`dbTxSync` 原语）、RFC-349（provider 抽象与 schema contract 地基）、RFC-351（SQLite 写事务一律预占 writer）、RFC-357（读面归一的可行性证明）
- 影响域：全后端持久化面
- 性质：**架构收敛**。不新增产品功能；目标是让「两个 provider 行为不同」在结构上不再可能发生。

## 1. 摘要

用户要求（2026-09-04）：**「数据库统一抽象，以后不允许再出现两种数据库一个好一个不好的分支。」**

本 RFC 把 provider 从**分支**降级为**客户端实现细节**：业务代码只有一份，provider 差异被压进
`DatabaseClient` 与一张闭合的方言表；`sqliteX.ts` / `postgresqlX.ts` 成对适配器整体退役。

## 2. 现状：provider 今天是一个 `if`，不是一个抽象

三层证据（全部来自前置对账，可复跑）：

1. **成对适配器 153 对**，SQLite 侧 30,135 行 / PostgreSQL 侧 49,288 行（1.63×）。差额不是方言，是
   **业务逻辑抄了第二遍**——SQLite 侧常是薄转调（逻辑在 `legacySqlite*`），PG 侧就地重写。
   典型：`sqliteCollaborationRouteOperations.ts` 117 行 ↔ `postgresqlCollaborationRouteOperations.ts` 2,268 行。
2. **启动路径就是字面意义的分支**：`cli/start.ts:1581` 是 `if (databaseProvider.provider !== 'sqlite') throw`，
   而 PG 分支在 `:1570` 进入永不返回的 `servePostgresqlDaemon`（`:1160-1162` `await new Promise(() => {})`）。
   于是 `cli/start.ts:1953–2256` 整段 **boot 恢复 / 迁移屏障 / 播种**在 PG 上按构造不可达。
3. **实证后果**：本机真 PostgreSQL 17.11 上，**每个任务在铸出任何 node_run 之前直接 failed**
   （`deferred-question-dispatcher-not-bound`）；同一工作流在 SQLite 上正常跑到 `review -> running`。

累计已确证 **12 条 P0 + 约 32 条 P1 + 约 21 条 P2**（含 RFC-357 已修的 6 条）。其中两条 P0 直接
掐断产品核心路径：PostgreSQL 上**评审无法通过 / 驳回、澄清无法回答**（三条命令端口从未注入且
PG 侧根本不存在实现，`commandContext.ts:161-186` 必抛），以及**每个任务在铸出 node_run 前必死**
（§2 第 3 条）。

这些不是 50 个独立 bug，是**同一个结构缺陷的 50 次表达**。

## 3. 为什么至今没能统一：唯一的真障碍是事务

RFC-350 的 `taskIdleTimeoutPersistence.ts` 已经是「一份实现两个 provider 共用」的**现成范例**，
它的头注释同时点明了为什么别处做不到：

> 可以这么做是因为本 adapter 只有纯读 + 两条单语句写、**没有事务**：SQLite 的 `dbTxSync` 与
> PostgreSQL 的异步事务那道真正的分歧在这里不存在……**抄成两份只会制造漂移**。

- `bun:sqlite` 的 `Database.transaction` 是**同步**包装器：async 回调在第一个 `await` 处被认为
  「已返回」，包装器当场 COMMIT。RFC-093 的 `dbTxSync` 因此在类型层把 Promise 回调塌成 `never`。
- PostgreSQL 客户端是 async。
- ⇒ 任何为一侧写的事务体在另一侧**语法上就跑不起来**。114 个文件依赖 `dbTxSync`，其中 76 个是
  SQLite 适配器。这就是 216 份适配器的来源。

**本 RFC 的核心论点：这条约束只对「bun:sqlite 的包装器」成立，不是 SQLite 事务的固有性质。**

2026-09-04 实测（`bun:sqlite`，三组对照）：

| 形态 | 体内抛错后残留 |
| --- | --- |
| ① `db.transaction(async () => {…})`（现状机制） | `["A1","A2"]` — **零原子性** |
| ② 显式 `BEGIN IMMEDIATE` + async 体 + 显式 `COMMIT`/`ROLLBACK` | `[]` — **真回滚** |
| ③ 同 ②，体内跨真实事件循环 tick（`setTimeout`） | 正常提交 |

自己用显式语句划事务边界，async 体在 SQLite 上就是安全的。仓内已有先例在这么做
（`platform/persistence/sqliteLogicalTarget.ts:222,287` 的 `exec('BEGIN IMMEDIATE')`）。

## 4. 目标

- **G1 一份实现**：每个 port 只有一个实现，`sqliteX.ts` / `postgresqlX.ts` 成对适配器退役。
- **G2 一条启动路径**：boot / 恢复 / 迁移屏障 / 播种只有一份，provider 不再是 `cli/start.ts` 里的分支。
- **G3 统一事务原语**：`await db.transaction(async tx => …)` 在两个 provider 上语义相同、原子性相同。
- **G4 方言闭集化**：provider 差异只允许存在于 `DatabaseClient` 实现与一张**具名、可枚举、带测试**
  的方言表（NULL 排序 / `LIKE` 大小写与转义符 / 布尔 / 裸行数值归一 / 错误码 / 锁语法）。
- **G5 结构性防复辟**：新增第二份 provider 实现在 CI 上必红；不是靠人自觉。
- **G6 真库是默认证据**：统一后的实现由**真 PostgreSQL** 在 push CI 上执行，不再靠脚本化 SQL runtime。

## 5. 非目标

- 不引入第三个 provider，不做多 daemon / 水平扩容 / 高可用（仍是 RFC-349 §4 的非目标）。
- 不改变任何**用户可见的产品行为**——除本 RFC 修复的既有 PG 缺陷外，行为逐字不变。
- 不重写业务逻辑本身：合一的是「谁来执行」，不是「执行什么」。
- 不碰安全（CLAUDE.md §工作准则 2026-08-26 硬规则）。

## 6. 能力影响清单（CLAUDE.md §RFC workflow 第 7 条，逐项呈确认）

本 RFC 会**收缩两处既有能力**，须逐项确认：

- **C-1 `dbTxSync` 退役为兼容层并最终删除。** 它的类型级「禁 async」保护随之消失，改由新原语的
  单写者租约 + 显式边界承担。风险：任何绕过新原语直接用 `db.transaction(async …)` 的新代码会重新
  失去原子性 ⇒ 以 lint 规则 + 架构守卫禁止裸 `db.transaction`（G5 的一部分）。
- **C-2 SQLite 写入从「同步执行」变为「异步执行 + 进程内单写者串行」。** 语义不变（RFC-351 之后
  每笔写事务本就 `BEGIN IMMEDIATE` 预占 writer），但吞吐特征变化：并发写请求改为在应用层排队而
  不是在 SQLite 层 busy-wait。需在 W1 用 RFC-311 基准库实测前后对比并写回本文件。

## 7. 验收标准

- **AC-1**（G1）`sqliteX.ts` / `postgresqlX.ts` 成对文件数从 **153 对降为 0**；架构守卫锁死该计数。
- **AC-2**（G2）`cli/start.ts` 不再有 `provider === 'sqlite'` 的执行分支；boot 序列只有一份，
  两个 provider 走同一条；`servePostgresqlDaemon` 那个永不返回的函数删除。
- **AC-3**（G3）`await db.transaction(async tx => …)` 在两个 provider 上通过同一份原子性对拍：
  体内抛错必回滚、体内跨事件循环 tick 必仍在同一事务、并发写不交错。**SQLite 侧以本 RFC §3 的
  三组实测为回归用例固化。**
- **AC-4**（G4）方言表是一份 exact 清单，每条带可执行断言与**两个 provider 各一次真实执行**；
  清单外不允许出现 `provider === '<literal>'` 分叉（既有豁免逐条登记并给理由）。
- **AC-5**（G5）新增任何 `sqlite*.ts`/`postgresql*.ts` 成对实现、或裸 `db.transaction(`、或新的
  `provider === ` 分叉，CI 必红并指向本 RFC。
- **AC-6**（G6）真 PostgreSQL lane 在 push CI 上执行统一实现的行为面（不只是 SQL 文本断言），
  且 lane 红则合并门红。
- **AC-7** 前置对账里的 **12 条 P0 全部消失**，每条带回归用例（先红后绿，变异实证）。
- **AC-8** 用户可见行为逐字不变：`/api/*` 的 wire 输出在两个 provider 上与本 RFC 之前的 SQLite
  输出相同（本 RFC 明确修复的缺陷除外，逐条列出）。
- **AC-9** exact-SHA CI 全绿（含真 PG lane），取证 sha 与 run id 写回本文件。

## 8. 用户裁决点（呈确认）

- **D1 事务原语形态**：采用「显式 `BEGIN IMMEDIATE` + 进程内单写者异步租约 + 显式 COMMIT/ROLLBACK」
  统一两个 provider，而不是保留两套机制。§3 已给出可行性实测。
- **D2 收敛节奏**：分波推进（见 plan.md），**每一波自身可发布**，不做一次性大爆炸切换。
- **D3 波次顺序**：先修 7 条 P0（让 PG 可用），再做事务原语，再逐 context 收敛适配器。
  理由：P0 不修的话，后面每一波都在一个跑不起来的 provider 上验证。
- **D4 C-1 / C-2 两项能力影响**（§6）接受与否。
