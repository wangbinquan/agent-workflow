// RFC-359 W5-T20 —— **方言表完备性**：凡业务代码用到的方言点，方言表里必须有声明。
//
// # 为什么这条守卫能存在（本仓的 PG 是怎么跑起来的）
//
// 本仓的 PostgreSQL 客户端是 drizzle 的 **sqlite-proxy**（`db/query.ts` 的
// `ProviderNeutralDatabase = BaseSQLiteDatabase<'sync' | 'async', …>`）。也就是说：**查询构造器
// 渲染的是 SQLite 方言的 SQL 文本**，再经 `platform/persistence/postgresqlSql.ts` 的
// `compilePostgresqlSql` 做一次**极窄**的改写（`?` → `$n`、ON CONFLICT 目标列去限定、
// PRAGMA/VACUUM/ATTACH fail-closed），然后原样交给 PG。这条链路没有第二个翻译层。
//
// 推论：**一句 SQL 里出现的每个函数名 / 每个语法构造，必须在两个引擎上同名同参地存在**，
// 否则它在 SQLite 上跑得好好的，在 PG 上是 `42883 undefined_function` / `42601 syntax_error`
// ——而且只在真跑到那条语句时才炸。这正是 RFC-359 对账里的「C 类方言陷阱」。
//
// # 方言表 = 两张**从生产代码派生**的声明面
//
//   ① **能力矩阵** `platform/persistence/capabilities.ts` —— provider 差异的容身处：实现只说
//      「锁这个聚合根」「NULL 排最后」「大小写不敏感搜索」，矩阵按引擎各渲染一次最优 SQL。
//   ② **PG 函数 shim** `platform/persistence/postgresqlSchema.ts` 的 bootstrap 语句 —— 给
//      PG 装上一组**同名同参**的 SQLite 标量函数（`unixepoch` / `instr` / `hex` / `max(a,b)` /
//      `json_valid` / `json_type` / `json_extract`），让同一句 SQL 两边都认。
//      ⚠️ `docs/dev-gotchas.md`：shim **同名同参、返回词汇表可以完全不同**（`json_type` 转发
//      `jsonb_typeof`，两套词汇几乎不重叠）。所以本守卫只判「声明在不在」，语义对齐是
//      `rfc357-provider-portability` 那一档的事——两条互补，缺一不可。
//
// # 判据（四条，都窄）
//
//   **J1 渲染权垄断**：方言构造（`for update` / `nulls last` / `ilike` / `INDEXED BY` / `PRAGMA` …）
//   只允许出现在 `DIALECT_RENDERERS` 具名的渲染器文件里——那里它按引擎各写一次。语料里其它
//   任何地方出现，逐条进 exact 账本 `RAW_DIALECT_DEBT`（逐字相等、只降不升、每条写明理由与清偿波次）。
//   **不采纳的宽松版**：「矩阵里存在同类能力方法即算已声明」——那样业务代码裸写 `for update`
//   也算绿，账本永远为空，守卫零预言力。
//
//   **J2 函数词汇闭集**：语料的 raw SQL 里出现的每个函数名，必须 ∈ 可移植核心
//   `PORTABLE_SQL_FUNCTIONS`（具名 + 逐条理由）∪ 从 `postgresqlSchema.ts` **派生**的 shim 集
//   ∪ J1 词汇表（那类由 J1 报）∪ 渲染器文件内部。否则进 `UNSHIMMED_FUNCTION_DEBT`。
//   今天该账本为空——它挡的是未来：谁写下 `strftime(` / `iif(` / `json_each(` / `group_concat(`
//   当场红，而不是等 PG 上某条冷路径 42883。
//
//   **J3 shim 集合逐字钉死**：派生出来的 shim 名字集合与 `POSTGRESQL_FUNCTION_SHIMS` 逐字相等。
//   删掉一个 shim（而业务还在用）或悄悄加一个，都必须留下一次有署名的提交。
//
//   **J4 矩阵自证**：词汇表里认领了能力方法的构造，那些方法名必须真的是 `EngineCapabilities`
//   的成员（从接口声明派生），且该构造必须**真的出现在矩阵文件里**——矩阵哪天不再渲染它，
//   先红在这条前提上，而不是让 J1 的账本安静地变绿。
//
// # 语料
//
// `tests/architecture/postgresqlSurface.ts` 的**类型可达**派生（不是文件名前缀），与 RFC-349
// 三条陷阱守卫共用。
//
// 2026-09-07（RFC-359 W7 第二波）补掉了原来的第一条盲区：`BUILDS_SQL` 此前只认 `sql\`` 与
// `.from(` 等构造痕迹，**整篇只用 `sql.raw('…')` 的文件一个都不进语料**——而 raw 文本恰恰完全
// 绕开查询构造器，最该被看住。加一条 `sql.raw(` 痕迹后语料 275 → 277，四条共用守卫里只有本文件
// 的 J1 多出一条真债（`resource-catalog` 的 `repositorySupport.ts` 手搓可串行化事务，已进
// `RAW_DIALECT_DEBT` 并写明 clearedBy）；其余三条陷阱守卫零新增。
//
// **剩余已知盲区**（不在本守卫职权内，记在这里免得被误读成已覆盖）：
//   · `db/schema.ts` 的 CHECK / DEFAULT 表达式（`json_valid` / `hex` / `unixepoch`）不经查询构造器，
//     走 `postgresqlSchema.ts` 的 DDL 投影，归 W5-T19g 的「迁移后 sqlite_master vs 逻辑契约」对账。
//   · `connection.unsafe(…)` 直连 Bun.SQL 的迁移 / 导出机件（`postgresqlMigrator` /
//     `postgresqlLogicalSource` / `postgresqlLogicalTargetInvariants`）：它们**本来就是 PG 专属工具**，
//     没有 SQLite 孪生，不是「两个引擎上跑的执行面」。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { postgresqlExecutionSurface } from './postgresqlSurface'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const MATRIX_FILE = 'platform/persistence/capabilities.ts'
const SCHEMA_PROJECTOR_FILE = 'platform/persistence/postgresqlSchema.ts'

/**
 * 允许裸写方言构造的**渲染器**文件：这些地方按引擎各渲染一次，是 provider 差异的容身处
 * （design §5「实现里永远不出现 provider 名；边界按引擎渲染最优 SQL」）。
 *
 * 具名 + 逐条理由，**不接受目录通配**——`platform/persistence/postgresql*.ts` 整目录放行的话，
 * 「矩阵已收编、原件还没退役」这类存量会当场消失在账本外。写下这条时的实例是一份独立的
 * NULL 排序模块（RFC-359 W11 已随最后一个调用方改指矩阵而删除）；例子退役了，理由没退役。
 */
const DIALECT_RENDERERS: Readonly<Record<string, string>> = {
  [MATRIX_FILE]:
    '能力矩阵本体：每个方言点在 createSqliteCapabilities / createPostgresqlCapabilities 里各渲染一次，' +
    '这是 RFC-359 design §5 指定的 provider 差异容身处。',
  'platform/persistence/databaseTransaction.ts':
    '统一事务原语：BEGIN IMMEDIATE（SQLite 独占）与 SET TRANSACTION ISOLATION LEVEL（PG）是同一个' +
    '「开启一个具备所需隔离形态的事务」能力的两侧渲染，design §3.3 指定它是第二个容身处。',
}

type EngineDialect = 'sqlite-only' | 'postgresql-only' | 'divergent'

interface DialectConstruct {
  /** 账本里的稳定标识；改名等于改账本。 */
  readonly id: string
  /** 打在 raw SQL 文本上的判据。 */
  readonly pattern: RegExp
  readonly dialect: EngineDialect
  /** 矩阵里承接它的能力方法（可为空 = 矩阵尚无对应项，须写在 why 里说明归哪一波）。 */
  readonly capability: readonly string[]
  readonly why: string
}

/**
 * **方言词汇表**：语法构造那一半（函数名那一半由 J2 的词汇闭集负责，两边不重叠，
 * 只有 `pg-greatest` / `advisory-lock` 例外——它们是函数，但矩阵已把它们收成能力项，
 * 所以由 J1 记账，J2 认它们已归类）。
 *
 * 命中数为 0 的条目**不是**过期豁免、不清理：它们挡的是未来第一次写下该构造的那个人。
 */
const DIALECT_CONSTRUCTS: readonly DialectConstruct[] = [
  {
    id: 'for-update',
    pattern: /\bfor\s+update\b/iu,
    dialect: 'postgresql-only',
    capability: ['lockAggregateRoot'],
    why: 'PG 行锁；SQLite 在 BEGIN IMMEDIATE 下已独占，没有对应物。读—改—写中间不锁的形状在 SQLite 上碰巧正确、在 PG 上是竞态。',
  },
  {
    id: 'skip-locked',
    pattern: /\bskip\s+locked\b/iu,
    dialect: 'postgresql-only',
    capability: ['claimLockClause'],
    why: '队列式认领：PG 多 worker 各拿各的；SQLite 独占事务下没有第二个认领者。',
  },
  {
    id: 'nulls-ordering',
    pattern: /\bnulls\s+(?:first|last)\b/iu,
    dialect: 'divergent',
    capability: ['ascNullsFirst', 'descNullsLast'],
    why: '两引擎默认 NULL 落位正好相反；认领类查询会因此饿死——这正是矩阵收编这条资产的来由。',
  },
  {
    id: 'ilike',
    pattern: /\bilike\b/iu,
    dialect: 'postgresql-only',
    capability: ['likeCaseInsensitive'],
    why: 'SQLite 的 LIKE 对 ASCII 天然大小写不敏感、PG 敏感；对齐只能靠 ilike。',
  },
  {
    id: 'like-escape',
    pattern: /\bescape\b/iu,
    dialect: 'divergent',
    capability: ['likeEscape', 'likeCaseInsensitive'],
    why: 'SQLite 无默认转义符、PG 默认是反斜杠；两侧都显式带 ESCAPE 才一致（对账 P1-28）。',
  },
  {
    id: 'indexed-by',
    pattern: /\bindexed\s+by\b/iu,
    dialect: 'sqlite-only',
    capability: ['indexHint'],
    why: 'SQLite 的索引强制；PG 无对应语法（planner 自选），矩阵在 PG 侧渲染成空。',
  },
  {
    id: 'pragma',
    pattern: /\bpragma\b/iu,
    dialect: 'sqlite-only',
    capability: ['reclaimScrubbedStorage'],
    why: 'SQLite 运维语句；compilePostgresqlSql 对它 fail-closed，走到 PG 就是硬失败。',
  },
  {
    id: 'vacuum',
    pattern: /\bvacuum\b/iu,
    dialect: 'sqlite-only',
    capability: ['reclaimScrubbedStorage'],
    why: 'SQLite 回收物理页；PG 交给 autovacuum，daemon 侧 no-op。',
  },
  {
    id: 'advisory-lock',
    pattern: /\bpg_advisory_[a-z_]*\s*\(/iu,
    dialect: 'postgresql-only',
    capability: ['advisoryLock'],
    why: 'PG 事务级 advisory lock；SQLite 的跨进程协调由 daemon 级 flock 承担。',
  },
  {
    id: 'pg-greatest',
    pattern: /\bgreatest\s*\(/iu,
    dialect: 'postgresql-only',
    capability: ['greatest'],
    why: 'PG 的 GREATEST 与 SQLite 的多参数 MAX 是同一语义两个关键字（SQLite 单参数 MAX 是聚合），只能分方言写。',
  },
  {
    id: 'set-transaction',
    pattern: /\bset\s+transaction\b/iu,
    dialect: 'postgresql-only',
    capability: [],
    why: 'PG 提升隔离级别的语句；SQLite 无对应物。矩阵只暴露只读的 isolation 形态，没有「把本事务提到 SERIALIZABLE」这一项——归 RFC-359 W4/W5 收进事务原语。',
  },
  {
    id: 'begin-immediate',
    pattern: /\bbegin\s+(?:immediate|deferred|exclusive)\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 的写事务起始形态；PG 用隔离级别表达。属统一事务原语的两侧渲染。',
  },
  {
    id: 'delete-using',
    pattern: /\bdelete\s+from\b[^;]{0,120}?\busing\b/iu,
    dialect: 'postgresql-only',
    capability: ['deleteByCandidates'],
    why: 'PG 的 DELETE … USING；SQLite 没有这个子句，等价写法是 DELETE … WHERE id IN (…)。RFC-359 W6-T25 起由矩阵的 deleteByCandidates 各渲染一次。',
  },
  {
    id: 'distinct-on',
    pattern: /\bdistinct\s+on\b/iu,
    dialect: 'postgresql-only',
    capability: [],
    why: 'PG 专属去重；SQLite 要靠窗口函数或 GROUP BY 重写。',
  },
  {
    id: 'json-arrow',
    pattern: /->>?|#>>?/u,
    dialect: 'postgresql-only',
    capability: ['jsonMemberText'],
    why: 'PG 的 JSON 取值算子；SQLite 只有 json_extract。W6-T24 已收进矩阵的 jsonMemberText——PG 渲染 `->` / `->>`（`pg_input_is_valid` 守住 `::jsonb`），SQLite 渲染三个内建 JSON 函数。',
  },
  {
    id: 'jsonb-contains',
    pattern: /@>|<@/u,
    dialect: 'postgresql-only',
    capability: [],
    why: 'PG 的 JSONB 包含算子；SQLite 要 json_each 展开。**W6-T24 判定不进矩阵**：`@>` 需要 jsonb 列，而 json-text 列必须保字节（rfc359-w6-t23-json-column-storage）；且全仓 14 处包含形状的过滤全打在几十到几百行的资源目录小表上，量不出收益。',
  },
  {
    id: 'pg-cast',
    pattern: /::\s*[a-z]/iu,
    dialect: 'postgresql-only',
    capability: [],
    why: 'PG 的 :: 强转语法；SQLite 只认 CAST(x AS t)（两边都认的写法）。',
  },
  {
    id: 'insert-or',
    pattern: /\binsert\s+or\s+(?:replace|ignore|abort|fail|rollback)\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 的冲突消解前缀；PG 只有 ON CONFLICT（两边都认的写法）。',
  },
  {
    id: 'glob',
    pattern: /\bglob\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 专属匹配算子；PG 无对应物（postgresqlSchema.ts 的表达式投影对它直接抛错）。',
  },
  {
    id: 'collate-nocase',
    pattern: /\bcollate\s+nocase\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 专属排序规则；PG 的列一律投影成 COLLATE "C"，NOCASE 无对应物。',
  },
  {
    id: 'rowid',
    pattern: /\browid\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 隐式行号；PG 没有（ctid 语义完全不同，不能替换）。',
  },
  {
    id: 'autoincrement',
    pattern: /\bautoincrement\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 的自增修饰；PG 用 identity / sequence。',
  },
  {
    id: 'attach-database',
    pattern: /\b(?:attach|detach)\s+database\b/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 多库挂载；compilePostgresqlSql 对它 fail-closed。',
  },
  {
    id: 'limit-comma',
    pattern: /\blimit\s+[^\s,)]+\s*,/iu,
    dialect: 'sqlite-only',
    capability: [],
    why: 'SQLite 的 `LIMIT offset, count` 简写；PG 只认 LIMIT … OFFSET …（两边都认的写法）。',
  },
]

/**
 * 两个引擎上**同名同参同义**的可移植核心。具名 + 逐条理由，**不接受通配**——
 * 「凡是 SQL-92 的都放行」这种写法等于把判据交给读者的记忆。
 *
 * 每条都必须在语料里真的被用到（下面有一条反向断言）：没人用了就删掉这一行，
 * 别让它变成停车场。
 */
const PORTABLE_SQL_FUNCTIONS: Readonly<Record<string, string>> = {
  avg: 'SQL-92 聚合，两侧同名同参。（返回类型差异——PG 对整型列返回 numeric、经 Bun.SQL 是字符串——由 rfc349-postgresql-numeric-projection 那条守卫负责，不在方言表职权内。）',
  coalesce: 'SQL-92 标量，两侧同名同参同义。',
  count: 'SQL-92 聚合，两侧同名同参。（int8 归一同 avg，另有守卫。）',
  length: 'SQL-92 标量，两侧对文本都按字符计。（blob/bytea 上都按字节，语义同样对齐。）',
  lower: 'SQL-92 标量；两侧都只对 ASCII 做无争议折叠，本仓的搜索路径正是按 ASCII 语义对齐的。',
  min: 'SQL-92 聚合（单参数形态）；多参数标量形态是 SQLite 专属，那一支由 max/greatest 一路处置。',
  substr:
    'SQL-92 `SUBSTRING` 的通用简写，两侧都原生提供 `substr(text, from, count)`，且都是 **1 起算、取 count 个字符**——语义逐字相同。RFC-359 W7 引入：已提交事件出站存储的 stage 筛子要按**字节**比消费者 id 前缀，不能用 `LIKE`（SQLite 的 LIKE 对 ASCII 大小写不敏感、PG 敏感，两侧筛出来的行会和各自 JS 投影的 stage 对不上，2026-09-07 双引擎对拍实测）。两个引擎上的真实执行由 `rfc359-w7-committed-events-conformance.test.ts` 覆盖。',
  sum: 'SQL-92 聚合，两侧同名同参。（int8 归一同 avg，另有守卫。）',
}

/**
 * PG 侧为 SQLite 标量函数装的**同名同参 shim**。键必须与 `postgresqlSchema.ts` 派生出来的
 * 集合逐字相等（J3）；值写清它在 PG 上**实际转发到什么**——`docs/dev-gotchas.md` 记过一次
 * 「同名同参、返回词汇表完全不同」的坑，光记名字挡不住它。
 */
const POSTGRESQL_FUNCTION_SHIMS: Readonly<Record<string, string>> = {
  hex: '转发 encode(convert_to(v,UTF8),hex) / encode(bytea,hex)；两个重载各一条 bootstrap。',
  instr: '转发 strpos(value, needle)::bigint。SQLite 与 PG 都是 1-based、未命中返回 0，语义对齐。',
  json_extract:
    '转发 jsonb -> 路径；**只认 `$.key` 这一种路径形态**，其余返回 NULL——写复杂路径在 PG 上会静默变 NULL。',
  json_type:
    '转发 jsonb_typeof：返回词汇是 object/array/string/number/boolean/null，与 SQLite 的 object/array/text/integer/real/true/false/null **几乎不重叠**（dev-gotchas 实测）。判据要写成对两套词汇都成立的形式。',
  json_valid: '转发 `v::jsonb` 的成败；SQLite 的 json_valid 亦只判可解析性，语义对齐。',
  max: '**双参数标量形态**的 shim，转发 greatest(a,b)。单参数聚合形态是 PG 原生的，不经 shim。',
  unixepoch: '转发 extract(epoch from clock_timestamp())::bigint，秒级；schema 默认值里都乘 1000。',
}

/** SQL 关键字：`IN (` / `EXISTS (` / `VALUES (` 这类形态不是函数调用。 */
const SQL_KEYWORDS = new Set([
  'all',
  'and',
  'as',
  'asc',
  'between',
  'by',
  'case',
  'cast',
  'desc',
  'delete',
  'distinct',
  'do',
  'else',
  'end',
  'escape',
  'exists',
  'filter',
  'for',
  'from',
  'group',
  'having',
  'in',
  'inner',
  'insert',
  'into',
  'is',
  'join',
  'key',
  'left',
  'like',
  'limit',
  'not',
  'nothing',
  'null',
  'of',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'over',
  'recursive',
  'returning',
  'right',
  'select',
  'set',
  'then',
  'union',
  'update',
  'using',
  'values',
  'when',
  'where',
  'with',
])

interface DialectDebtRow {
  /** 相对 `packages/backend/src` 的路径。 */
  readonly file: string
  readonly construct: string
  readonly count: number
  readonly why: string
  /** 具名清偿波次；不接受「以后再说」。 */
  readonly clearedBy: string
}

/**
 * **裸方言构造的 exact 账本**（`<file>: <construct> ×<count>`，按行字典序）。只降不升。
 *
 * 增了 = 有人在渲染器之外裸写了一个方言点：改成调矩阵的对应能力方法；矩阵没有那一项就
 * **给矩阵加一项并补两侧实测**（design §5 闭集纪律），而不是把新行塞进这张表。
 * 减了 = 收敛发生了：把这张表一起改小，让每一次减少都留下一次有署名的提交。
 */
const RAW_DIALECT_DEBT: readonly DialectDebtRow[] = [
  // RFC-359 W10 销账：`modules/resource-catalog/infrastructure/postgresql/repositorySupport.ts:
  // set-transaction ×1` —— `runPostgresqlResourceCatalogTransaction` 已删除。
  //
  // **这一行的 `why` 曾把处置写错，记在这里供后来人对照**：它写的是「**正确动作**是改调中立原语」，
  // 前提是这个 helper 还有人用。逐个 import 核过之后事实是 **零生产调用方**——`packages/backend/src`
  // 下没有任何一处 import 它；全仓提到这个名字的只有三份**反向**源码文本守卫
  // （`rfc349-resource-catalog-intent-apply-postgresql.test.ts:29-30` /
  // `rfc349-resource-catalog-postgresql-adapters.test.ts:264` /
  // `rfc345-intent-context-resource-authorization.test.ts:38`，它们断言这个名字**不**出现）
  // 外加账本自己。resource-catalog 的 PG 适配器从头到尾走 `db.transaction(...)` 直连，
  // 从没经过它。于是处置是**删除**，不是改调——改调会凭空给一段死代码续命。
  //
  // 一般规律（读这本账本时带上）：账本行里由人写下的 `why` / `clearedBy` 是**当时的假设**，
  // 不是事实。销账前先把「谁在用它」按 import 逐条验一遍——`why` 说得越具体，越容易让人
  // 跳过这一步。
  // ──────────────────────────────────────────────────────────────────────────
  // RFC-359 W11 销账：`modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts:
  // pg-greatest ×1` —— 祖先链「只前进不后退」的分支时间戳回填改调 `engineOf(tx).greatest(...)`，
  // 可空侧的 `coalesce(...)` 留在调用方（两个引擎都认的写法）。
  //
  // **原 `why` 把孪生认错了，记在这里供后来人对照**：它写的是「SQLite 孪生 taskDeleteRecovery.ts
  // 用 MAX(...) 读回来再在 JS 里 Math.max」。逐个核过之后事实是两码事——`taskDeleteRecovery.ts`
  // 做的是**删除之后重算**（`coalesce(max(col), 0)` 是**聚合** max，两个引擎原生同名同义），
  // 它本来就是一份中立实现，没有任何方言。真正与这条 PG 回填成对的 SQLite 孪生是
  // `services/task.ts` 铸任务时那段同形的祖先链 `MAX(branch_started_at, now)`（同样 64 层上限、
  // 同样的循环）。**它不在本账本上**：两参数 `max` 在 PG 侧有同名同参 shim（转发 greatest），
  // J2 因此认它已声明；这一对的合一是另一刀的活（那份文件此刻正被并发施工占着）。
  //
  // 顺带钉住一格**矩阵没有抹平**的语义分歧：SQLite 的多参数 `max` 对 NULL 传染（任一参数 NULL
  // ⇒ 结果 NULL），PG 的 `GREATEST` 忽略 NULL。所以 `greatest()` 的可空侧必须由调用方 COALESCE。
  // 双引擎实测见 `tests/rfc359-w11-dialect-ledger-conformance.test.ts`——那也是这个算子的
  // **第一次**真实执行断言（矩阵的「每项两侧各一次真实执行」在它身上此前是空的）。
  // ──────────────────────────────────────────────────────────────────────────
  // RFC-359 W11 销账：`modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts:
  // for-update ×2` —— 两处的处置**不一样**，这正是销账前要逐处核实的理由：
  //   · `withPostgresqlTaskAggregateTransaction` 事务头那处**有生产调用方**（成员替换），
  //     改调 `engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)`；渲染权归矩阵之后
  //     这个 opener 顺带在 SQLite 上也跑得动了（裸 `for update` 在 SQLite 上是语法错误），
  //     双引擎对拍因此第一次能同时喂到它。
  //   · `lockPostgresqlNodeRunAggregateRoot` 那处**零生产调用方**——node run 的写路径在 W4-B1
  //     合成一份之后走的是统一写事务原语 + 矩阵的 `lockAggregateRoot`，这个导出（连同同族的
  //     `withPostgresqlNodeRunAggregateTransaction`）从此只被两份测试引用着。处置是**删除**，
  //     不是改调；判「零生产消费者」时要把测试排除在消费者之外。
  //
  // RFC-359 W5-T18 销账：同文件 `set-transaction ×1` —— `withPostgresqlSerializableTaskExecution`
  // 不再自己 `sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')` + 自己写 40001 重试循环，
  // 整个事务边界改走 `databaseSessionFor(db).serializable(...)`。那句方言现在只剩中立原语里的一处
  // （`platform/persistence/databaseTransaction.ts`，它本来就是渲染器），隔离级别的语义一字未变
  // ——中立原语的 `serializable` 显式记着以本文件当年那段为蓝本。
  // ──────────────────────────────────────────────────────────────────────────
  // RFC-359 W11 销账：`platform/persistence/maintenanceExecutionFence.ts: indexed-by ×1` ——
  // 两份实现（SQLite 裸 raw SQL + PG 查询构造器）合成一份，索引提示由 `engineOf(db).indexHint()`
  // 渲染：SQLite `INDEXED BY "<index>"`、PG 空。SQLite 侧当初裸写它的**全部理由**（满库终态
  // node run 时 planner 会改选整表扫）由对拍里的 `EXPLAIN QUERY PLAN` 断言接着守住。
  // ──────────────────────────────────────────────────────────────────────────
  // RFC-359 W6-T25 销账：`platform/persistence/postgresqlMaintenanceRetention.ts: delete-using ×4`
  // （该文件已于 W57 整份删除——它与 SQLite 那份逐字相同，两个引擎现在跑同一段实现）
  // —— 四条保留期清扫语句不再自己拼 `DELETE … USING candidates`，改调矩阵的
  // `EngineCapabilities.deleteByCandidates`（PG 渲染 CTE + USING，SQLite 渲染 `WHERE id IN (…)`）。
  // 两侧此后只提供**谓词与 LIMIT**；SQLite 孪生原来按 `rowid` 删、现在按主键删——这三张事件表的
  // `id` 就是 `INTEGER PRIMARY KEY AUTOINCREMENT`（rowid 别名），`webhook_trigger_fires` 的 `id`
  // 是 ULID 主键，选中的是同一批行。顺带把两侧各存一份的批大小常量
  // （`RETENTION_DELETE_BATCH` / `POSTGRESQL_RETENTION_DELETE_BATCH`）收成矩阵里的
  // `BOUNDED_DELETE_MAX_ROWS` 一处——那正是 T25 守卫禁止 `runner.ts` 干的「仓里第二份批大小推导」，
  // 只是它在 DELETE 侧、此前逃过了那条守卫。
  //
  // **没有一并做的事**（留债，别读成已完成）：两个 retention 文件的**游标 / 相位 / 四条谓词**仍是
  // 各写一份（`rfc359-w8-retention-parity.test.ts` 是它们的对拍）。合一它们要动
  // `platform/background/maintenanceWorker.ts` 的两个调用点，不在本刀的路径域内。
  // ──────────────────────────────────────────────────────────────────────────
  // RFC-359 W11 销账：`platform/persistence/postgresqlNullOrdering.ts: nulls-ordering ×2` ——
  // 矩阵早已收编这条资产，缺的只是把最后一个调用方改指过去然后删掉原件。核过之后全仓只有
  // **一个**生产调用方（任务详情的 node run 时间线），改成 `engineOf(db).ascNullsFirst(...)`
  // 之后整份文件删除。同时把三处只在注释里提到它的地方一并更正——注释不会随代码演进自动作废，
  // 留着会让下一个人以为还有第二份渲染。
]

/** 用到了却既不可移植、也没 shim、也不在方言词汇表里的函数。目标态是空。 */
const UNSHIMMED_FUNCTION_DEBT: readonly string[] = []

// ─────────────────────────────────────────────────────────────────────────────
// 判据实现（纯函数：负 fixture 喂的就是它们，不碰真实语料）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个源文件里全部**会被发往数据库的 SQL 文本**。
 *
 * 只取 `sql` 标签模板的**字面量段**与 `sql.raw('<字面量>')`：插值位置替换成 ` ? `，于是
 * TS 表达式不会被当成 SQL（`Math.max(` 不该报成 SQL 函数），而跨插值的构造仍然连得上
 * （`DELETE FROM ${t} USING candidates` 必须还能看出是 DELETE … USING）。
 * 嵌套在插值里的 `sql\`…\`` 由 AST 遍历各自成段，不会漏。
 */
export function sqlFragments(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true)
  const out: string[] = []
  const push = (fragment: string): void => {
    if (fragment.trim().length > 0) out.push(fragment)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(source) === 'sql') {
      const template = node.template
      push(
        ts.isNoSubstitutionTemplateLiteral(template)
          ? template.text
          : [template.head.text, ...template.templateSpans.map((span) => span.literal.text)].join(
              ' ? ',
            ),
      )
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'sql.raw' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // `--` 行注释里的 SQL 只是说明，不发往数据库。
  return out.map((fragment) => fragment.replaceAll(/--[^\n]*/gu, ' '))
}

/** J1：一个文件里的方言构造命中，形如 `<path>: <construct> ×<count>`。 */
export function dialectConstructFindings(path: string, text: string): string[] {
  const counts = new Map<string, number>()
  for (const fragment of sqlFragments(path, text)) {
    for (const construct of DIALECT_CONSTRUCTS) {
      if (construct.pattern.test(fragment)) {
        counts.set(construct.id, (counts.get(construct.id) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()].map(([id, count]) => `${path}: ${id} ×${count}`).sort()
}

/** J2：一个文件的 raw SQL 里出现的函数名（小写、去重、已剔除关键字与本地 CTE 名）。 */
export function sqlFunctionNames(path: string, text: string): string[] {
  const names = new Set<string>()
  for (const fragment of sqlFragments(path, text)) {
    const ctes = new Set<string>()
    for (const match of fragment.matchAll(
      /\b(?:with\s+(?:recursive\s+)?|,\s*)([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(/giu,
    )) {
      ctes.add(match[1]!.toLowerCase())
    }
    for (const match of fragment.matchAll(/(?<![A-Za-z0-9_."])([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu)) {
      const name = match[1]!.toLowerCase()
      if (SQL_KEYWORDS.has(name) || ctes.has(name)) continue
      names.add(name)
    }
  }
  return [...names].sort()
}

/** J3：从 `postgresqlSchema.ts` 的 bootstrap 语句派生出来的 PG shim 函数名。 */
export function postgresqlFunctionShims(projectorText: string): string[] {
  const names = new Set<string>()
  for (const match of projectorText.matchAll(
    /CREATE OR REPLACE FUNCTION\s+(?:\$\{[^}]*\}|"[^"]*")\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu,
  )) {
    names.add(match[1]!.toLowerCase())
  }
  return [...names].sort()
}

/** J4：从 `capabilities.ts` 的接口声明派生出来的能力项名字。 */
export function engineCapabilityMembers(matrixText: string): string[] {
  const source = ts.createSourceFile('capabilities.ts', matrixText, ts.ScriptTarget.ESNext, true)
  const members: string[] = []
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'EngineCapabilities') {
      continue
    }
    for (const member of statement.members) {
      if (member.name !== undefined) members.push(member.name.getText(source))
    }
  }
  return members.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 采数
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE = postgresqlExecutionSurface(SRC)
const RENDERER_PATHS = new Set(Object.keys(DIALECT_RENDERERS))
const CONSTRUCT_IDS = new Set(DIALECT_CONSTRUCTS.map((construct) => construct.id))

const observedDebt: string[] = []
const matrixConstructIds = new Set<string>()
const unshimmed = new Set<string>()
let fragmentCount = 0

for (const file of SURFACE) {
  const fragments = sqlFragments(file.path, file.text)
  fragmentCount += fragments.length
  const findings = dialectConstructFindings(file.path, file.text)
  if (RENDERER_PATHS.has(file.path)) {
    if (file.path === MATRIX_FILE) {
      for (const finding of findings) {
        matrixConstructIds.add(finding.slice(finding.indexOf(': ') + 2, finding.lastIndexOf(' ×')))
      }
    }
    continue // 渲染器按引擎各写一次，是方言点的家。
  }
  observedDebt.push(...findings)
  for (const name of sqlFunctionNames(file.path, file.text)) {
    if (PORTABLE_SQL_FUNCTIONS[name] !== undefined) continue
    if (POSTGRESQL_FUNCTION_SHIMS[name] !== undefined) continue
    // 已被方言词汇表认领的函数（greatest / pg_advisory_*）由 J1 报，这里不重复记账。
    if (DIALECT_CONSTRUCTS.some((construct) => construct.pattern.test(`${name}(`))) continue
    unshimmed.add(`${file.path}: ${name}()`)
  }
}

const ledgerRows = RAW_DIALECT_DEBT.map(
  (row) => `${row.file}: ${row.construct} ×${String(row.count)}`,
).sort()

describe('RFC-359 W5-T20 —— 方言表完备性：语料', () => {
  test('语料下限：PG 执行面塌了就先红在这里，而不是让下面每条断言假绿', () => {
    expect(
      SURFACE.length,
      '按类型可达派生的 PG 执行面塌了 ⇒ 本文件全部判据零预言力',
    ).toBeGreaterThanOrEqual(150)
    expect(
      fragmentCount,
      '语料里一句 raw SQL 都没提取到 ⇒ sqlFragments 的 AST 判据失效（sql 标签改名 / 模板形态变了）',
    ).toBeGreaterThanOrEqual(60)
  })

  test('矩阵文件确实在语料里，且确实是方言点的家（不在语料里 = J1 的豁免在放空枪）', () => {
    expect(SURFACE.some((file) => file.path === MATRIX_FILE)).toBe(true)
    expect(matrixConstructIds.size).toBeGreaterThanOrEqual(8)
  })
})

describe('RFC-359 W5-T20 —— J1 渲染权垄断', () => {
  test('渲染器之外的裸方言构造与账本逐字相等（增了是新分叉，减了是收敛，都要改账本）', () => {
    expect(
      observedDebt.sort(),
      '能力矩阵之外裸写了方言构造。**正确动作**：改调 capabilities 的对应能力方法；' +
        '矩阵没有那一项就给矩阵加一项并补两侧真引擎实测（design §5 闭集纪律），' +
        '而不是往 RAW_DIALECT_DEBT 里加一行。确有理由保留，就加行并写清 why / clearedBy。' +
        '**减少**同样要红——把账本一起改小，让这次收敛留下一次有署名的提交。',
    ).toEqual(ledgerRows)
  })

  test('账本每条都具名带理由与清偿波次，无重复、按字典序（豁免不许通配、不许「以后再说」）', () => {
    const keys = RAW_DIALECT_DEBT.map((row) => `${row.file}: ${row.construct}`)
    expect(new Set(keys).size, '账本里有重复的 (文件, 构造)').toBe(keys.length)
    expect([...keys].sort()).toEqual(keys)
    expect(CONSTRUCT_IDS.size, '方言词汇表里有重复的 id').toBe(DIALECT_CONSTRUCTS.length)
    const unknown = keys.filter((key) => !CONSTRUCT_IDS.has(key.slice(key.indexOf(': ') + 2)))
    expect(
      unknown,
      '账本引用了词汇表里不存在的构造 id ⇒ 打字错了，这一行永远匹配不到任何东西',
    ).toEqual([])
    const bad = RAW_DIALECT_DEBT.filter(
      (row) =>
        row.why.trim().length < 20 ||
        row.clearedBy.trim().length < 10 ||
        !/RFC-\d{3}|W\d|B\d{1,2}|D\d{1,2}/.test(row.clearedBy),
    ).map((row) => `${row.file}: ${row.construct}`)
    expect(bad, 'clearedBy 必须点名具体 RFC / 波次；why 要写清这条债的形状').toEqual([])
  })

  test('渲染器豁免逐条具名带理由，且指向真实存在的文件（通配 / 过期条目都不接受）', () => {
    const missing = Object.keys(DIALECT_RENDERERS).filter((path) => {
      try {
        return readFileSync(resolve(SRC, path), 'utf8').length === 0
      } catch {
        return true
      }
    })
    expect(missing, '渲染器豁免指向了不存在的文件 ⇒ 该豁免要么改路径、要么删除').toEqual([])
    const thin = Object.entries(DIALECT_RENDERERS)
      .filter(([, why]) => why.trim().length < 30)
      .map(([path]) => path)
    expect(thin, '每条渲染器豁免都要写清「为什么这里可以裸写方言」').toEqual([])
  })

  test('negative fixture：捏造的源码证明 J1 的判据两个方向都真的在判', () => {
    const violating = [
      'const claim = sql`select * from jobs where status = ? for update skip locked`',
      "const purge = sql.raw('PRAGMA wal_checkpoint(TRUNCATE)')",
    ].join('\n')
    expect(dialectConstructFindings('services/orders.ts', violating)).toEqual([
      'services/orders.ts: for-update ×1',
      'services/orders.ts: pragma ×1',
      'services/orders.ts: skip-locked ×1',
    ])

    // 跨插值的构造必须仍然连得上——按插值切段的实现会在这里漏掉 DELETE … USING。
    const straddling = 'const sweep = sql`DELETE FROM ${table} USING candidates WHERE id = ?`'
    expect(dialectConstructFindings('services/sweep.ts', straddling)).toEqual([
      'services/sweep.ts: delete-using ×1',
    ])

    // 插值里的 TS 代码不是 SQL：`Math.max(...)` 不得被报成 pg-greatest / 函数词汇。
    const tsOnly = 'const bump = sql`update t set v = ${Math.max(a, b)} where id = ${id}`'
    expect(dialectConstructFindings('services/bump.ts', tsOnly)).toEqual([])
    expect(sqlFunctionNames('services/bump.ts', tsOnly)).toEqual([])

    // 非 sql 标签的模板字面量不是 SQL（散文 / 日志里出现关键词不该报）。
    const prose = 'const note = `this query used to say for update, we removed it`'
    expect(dialectConstructFindings('services/note.ts', prose)).toEqual([])
  })
})

describe('RFC-359 W5-T20 —— J2 函数词汇闭集', () => {
  test('语料里的每个 SQL 函数都在方言表里有声明（可移植核心 / PG shim / 矩阵能力项）', () => {
    expect(
      [...unshimmed].sort(),
      '这些函数既不在可移植核心、也没有 PG shim、也不是矩阵渲染的能力项。' +
        '本仓的 PG 客户端是 drizzle sqlite-proxy：查询构造器发出的就是这段文本，' +
        'PG 上没有同名同参的函数 ⇒ 运行到该语句时 42883，SQLite 上却一路绿。' +
        '**正确动作**：换成可移植写法；确实需要就去 postgresqlSchema.ts 加一条同名 shim（并写清它转发到什么），' +
        '或给能力矩阵加一项按引擎渲染。',
    ).toEqual([...UNSHIMMED_FUNCTION_DEBT].sort())
  })

  test('可移植核心无过期条目：列在表里就必须真的有人用（否则删掉这一行）', () => {
    const used = new Set<string>()
    for (const file of SURFACE) {
      for (const name of sqlFunctionNames(file.path, file.text)) used.add(name)
    }
    const stale = Object.keys(PORTABLE_SQL_FUNCTIONS)
      .filter((name) => !used.has(name))
      .sort()
    expect(stale, '可移植核心里有没人用的条目 ⇒ 删掉，别让这张表变成停车场').toEqual([])
  })

  test('negative fixture：未声明的 SQLite 专属函数会被 J2 的判据报出来', () => {
    const drifted =
      "const q = sql`select strftime('%s', created_at) as s, group_concat(name) from t`"
    expect(sqlFunctionNames('services/report.ts', drifted)).toEqual(['group_concat', 'strftime'])
    for (const name of ['strftime', 'group_concat', 'iif', 'json_each', 'randomblob']) {
      expect(
        PORTABLE_SQL_FUNCTIONS[name] === undefined && POSTGRESQL_FUNCTION_SHIMS[name] === undefined,
        `${name} 被当成了已声明的方言点——它既不可移植也没 shim`,
      ).toBe(true)
    }
    // 反向：已声明的那些必须被判为「已覆盖」，否则判据宽到会误报。
    for (const name of ['instr', 'json_extract', 'unixepoch', 'coalesce', 'lower']) {
      expect(
        PORTABLE_SQL_FUNCTIONS[name] !== undefined || POSTGRESQL_FUNCTION_SHIMS[name] !== undefined,
        `${name} 明明在方言表里，却被判成未声明`,
      ).toBe(true)
    }
  })
})

describe('RFC-359 W5-T20 —— J3 / J4 方言表自证', () => {
  test('PG shim 集合与生产投影器派生结果逐字相等（删一个 shim 就红）', () => {
    const derived = postgresqlFunctionShims(
      readFileSync(resolve(SRC, SCHEMA_PROJECTOR_FILE), 'utf8'),
    )
    expect(
      derived,
      'postgresqlSchema.ts 的 bootstrap 函数集合变了。**删**一个 shim 而业务还在用，' +
        '就是把一条 SQL 变成 PG 上的 42883；**加**一个 shim 要连带写清它转发到什么' +
        '（dev-gotchas：同名同参、返回词汇表可以完全不同）。两种都必须留下一次有署名的提交。',
    ).toEqual(Object.keys(POSTGRESQL_FUNCTION_SHIMS).sort())
    expect(derived.length).toBeGreaterThanOrEqual(5)
  })

  test('方言词汇表认领的能力方法都是 EngineCapabilities 的真成员（矩阵改名就红）', () => {
    const members = new Set(
      engineCapabilityMembers(readFileSync(resolve(SRC, MATRIX_FILE), 'utf8')),
    )
    expect(
      members.size,
      '没从 capabilities.ts 解析出任何能力项 ⇒ 本条断言零预言力',
    ).toBeGreaterThanOrEqual(10)
    const dangling = DIALECT_CONSTRUCTS.flatMap((construct) =>
      construct.capability
        .filter((name) => !members.has(name))
        .map((name) => `${construct.id} -> ${name}`),
    ).sort()
    expect(dangling, '方言词汇表指向了矩阵里不存在的能力项（改名 / 删除后忘了同步）').toEqual([])
  })

  test('认领了能力项的构造，矩阵里必须真的渲染它（矩阵停止渲染就先红在这条前提上）', () => {
    const claimed = DIALECT_CONSTRUCTS.filter((construct) => construct.capability.length > 0)
    expect(claimed.length, '没有任何构造认领能力项 ⇒ 本条零预言力').toBeGreaterThanOrEqual(8)
    const absent = claimed
      .filter((construct) => !matrixConstructIds.has(construct.id))
      .map((construct) => construct.id)
      .sort()
    expect(
      absent,
      '这些方言点声称由矩阵承接，矩阵里却找不到对应的渲染 ⇒ 要么矩阵回退了，' +
        '要么词汇表的 capability 写错了；无论哪种，J1 的账本此刻都在放空枪',
    ).toEqual([])
  })

  test('negative fixture：shim / 能力项的派生判据本身在判，不是永远返回空', () => {
    const fabricatedProjector = [
      "bootstrap('soundex', `CREATE OR REPLACE FUNCTION ${quote(S)}.soundex(v TEXT) RETURNS TEXT AS $$ … $$`),",
      "bootstrap('nope', 'SELECT 1'),",
    ].join('\n')
    expect(postgresqlFunctionShims(fabricatedProjector)).toEqual(['soundex'])

    const fabricatedMatrix = [
      'export interface EngineCapabilities {',
      "  readonly provider: 'sqlite' | 'postgresql'",
      '  lockAggregateRoot(): Promise<void>',
      '}',
      'export interface Unrelated { shouldNotAppear(): void }',
    ].join('\n')
    expect(engineCapabilityMembers(fabricatedMatrix)).toEqual(['lockAggregateRoot', 'provider'])
  })
})
