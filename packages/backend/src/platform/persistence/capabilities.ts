// RFC-359 W2-T11b —— 引擎能力矩阵：provider 差异的唯一容身处之一。
//
// # 原则：一份实现按「能力」提需求，边界按引擎渲染最优 SQL；实现里永远不出现 provider 名
//
// 「一份实现」与「PostgreSQL 最高性能」互相拉扯：按最小公分母写，PG 拿不到行锁 / SKIP LOCKED
// 这些它独有的最优路径；靠 PG 专属代码路径，又回到分叉。本矩阵是两者唯一的交点——实现只说
// 「锁这个聚合根」「认领时跳过已锁的行」「这个错误是不是唯一冲突」，每个 provider 各渲染一次。
// 这条原则本仓在 containment provider 上早已立过（docs/audit-backlog.md：「driver 不得按
// provider/OS 分叉，要按能力区分」）。
//
// # 闭集纪律
//
// 矩阵是 exact 的：每一项在两个引擎上各有一次**真实执行**的断言（rfc359-engine-capabilities.test.ts）。
// 实现层发现矩阵缺一项时，正确动作是**给矩阵加一项并补两侧测试**，不是在实现里写
// `if (provider === …)`——那会被 RFC-359 W5 的守卫判红。
//
// # 收进来的既有资产（此前散在各处，各自正确、彼此不知）
//
//   · NULL 排序：两引擎默认正好相反；认领类查询会因此饿死。原件是一份独立的 PG 专属模块，
//     RFC-359 W11 把最后一个调用方改指 `engineOf(db).ascNullsFirst` 之后已整份删除——
//     `ascNullsFirst` / `descNullsLast` 现在是全仓唯一的渲染处。
//   · LIKE 大小写：`rfc349-provider-search-case-parity`（SQLite ASCII 不敏感 / PG 敏感 ⇒ ilike）
//   · LIKE 转义符：本轮对账 P1-28（SQLite 无默认转义符 / PG 默认是 `\`；两侧都显式带 ESCAPE 才一致）
//   · 裸行数值归一：RFC-357 `taskListPage/projection.ts`（PG 的 int8 经驱动回来是字符串）
//   · 错误分类：`postgresqlSerializationRetry.ts` 的 `errno` 判据——Bun.SQL 把 SQLSTATE 放在
//     `errno`，`code` 恒为 ERR_POSTGRES_SERVER_ERROR。本轮对账 F-I-13 发现
//     `isPostgresqlUniqueViolation` 只看 `code`，在真 PG 上恒为 false ⇒ 并发同名拿 500 而非 409。
//   · 行锁与 advisory lock：`postgresqlTaskLifecycleTransaction.ts:100` 与已提交事件 append 的
//     聚合序号互斥（RFC-359 W7 起是 `platform/events/committed/append.ts` 里的
//     `engineOf(tx).advisoryLock`；此前是已删除的 `committed/postgresqlPersistence.ts` 的私有写法）。
//
// # 隔离级别（PG 侧默认 READ COMMITTED，见 databaseTransaction.ts §3.3）
//
// `docs/dev-gotchas.md` 第 6 条的实测：小表上 SERIALIZABLE 的 predicate lock 是索引页粒度，
// 8 并发满速冲突率 81.2%；READ COMMITTED + 聚合根 FOR UPDATE 后 0%。所以矩阵给的是行锁，
// 不是隔离级别。

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { SQLiteSyncDialect, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'

import { postgresqlSerializationFailureCode } from '@/db/postgresqlSerializationRetry'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'
import type { DatabaseTransaction } from './databaseTransaction'

/** SQLite 的绑定参数预算：保守值，见 `EngineCapabilities.batchInsertMax` 的注释。 */
const SQLITE_MAX_BIND_PARAMETERS = 32_766
/** PostgreSQL 的绑定参数预算：wire protocol 的 int16 参数计数上限。 */
const POSTGRESQL_MAX_BIND_PARAMETERS = 65_535

/**
 * RFC-359 W6-T25 —— 一条「按候选集有界删除」一次最多删多少行。**仓里唯一的一份**。
 *
 * 它与 `batchInsertMax` 不是同一个预算：候选集是**子查询**，整条语句只带一个 LIMIT 绑定参数，
 * 所以绑定参数上限在这里不构成约束；约束是「单条 DELETE 持写锁多久」——SQLite 上一条长删会挡住
 * 整个库的写者，PG 上会把被删行全部锁住。
 *
 * 5000 是 RFC-311 落地时选的值，此前**两侧各存了一份**（`sqlite/systemMaintenanceRetention.ts` 的
 * `RETENTION_DELETE_BATCH` 与 `postgresqlMaintenanceRetention.ts` 的
 * `POSTGRESQL_RETENTION_DELETE_BATCH`）——那正是 T25 守卫禁止 `runner.ts` 干的「仓里第二份批大小
 * 推导」，只是它在 DELETE 侧、逃过了那条守卫。现在两侧都从这里取。
 */
export const BOUNDED_DELETE_MAX_ROWS = 5_000

export type EngineErrorClass = 'unique-violation' | 'serialization' | 'busy' | 'other'

export interface EngineCapabilities {
  /** 只供矩阵自身的测试与诊断日志读；业务代码读它就是分叉，W5 守卫会红。 */
  readonly provider: DatabaseProvider
  /** 事务体看到的隔离形态：PG 是多写并发（须显式行锁）；SQLite 在 BEGIN IMMEDIATE 下独占。 */
  readonly isolation: 'read-committed' | 'exclusive'
  /** 一条语句可带的绑定参数**预算**（保守值，不是实测硬顶——见 `batchInsertMax`）。 */
  readonly maxBindParameters: number

  /**
   * RFC-359 W6-T25 —— 一条多行 INSERT 最多能带几行。
   *
   * 它与 `maxBindParameters` **不是同一个概念**，关系是「取小」：
   *   ① 参数预算：一行占 `columnCount` 个绑定参数 ⇒ `floor(maxBindParameters / columnCount)`；
   *   ② 引擎自己的行数甜点：再大也不会更快，而单条语句越大、失败时回滚的代价越高。
   * 两者的**推导只写一次**（`batchInsertMaxRows`），每个引擎只提供自己的两个数。
   *
   * 甜点两侧都取仓内既有的 `SQL_IN_CHUNK`（500）——不新造常量。2026-09-07 双引擎实测
   * （node_run_events，6 列，单事务内插 n 行）：
   *   SQLite   n=1000  逐行 28.0ms / 每批 100 行 11.6ms / **每批 500 行 9.0ms** / 整批 9.9ms
   *   PostgreSQL n=1000 逐行 428.2ms / 每批 100 行 24.4ms / **每批 500 行 21.8ms** / 整批 23.2ms
   *   两个引擎在 500 行处都已到平台期，100 行反而慢（PG n=5000：105.7ms vs 89.8ms）。
   *
   * **参数预算是保守值而不是实测硬顶**：同日实测本机 bun 1.3.13 上两个引擎的真实上限都是
   * 65535 个参数（10922×6=65532 过、10923×6=65538 抛）——SQLite 侧是 bun:sqlite 绑定层的限制、
   * PostgreSQL 侧是 wire protocol 的 int16 参数计数。`util/sqlChunk.ts` 已记过「SQLite 的上限
   * 随构建而变」，所以矩阵继续按保守预算切批，不去贴那个会飘的天花板。
   */
  batchInsertMax(columnCount: number): number

  /**
   * RFC-359 W6-T25 —— **按候选集的有界删除**：一条语句删掉 `candidates` 选出来的那些行，
   * 并把删掉的主键回吐（调用方据此判「这一批满了没有」来决定是否继续下一片）。
   *
   * `candidates` 是调用方给的**至多 `BOUNDED_DELETE_MAX_ROWS` 行**的主键 SELECT，它的唯一输出列
   * 必须**别名为 `id`**（PG 侧要靠这个名字 join 回来）。谓词与 LIMIT 都在调用方手里，这里只管
   * 「怎么把候选集变成一条删除语句」这一件按引擎不同的事：
   *
   *   · PostgreSQL —— `WITH candidates AS (…) DELETE … USING candidates WHERE pk = candidates.id`。
   *   · SQLite —— 没有 `USING` 子句，等价写法是 `DELETE … WHERE pk IN (…)`。
   *
   * 合一前这条方言点在 `postgresqlMaintenanceRetention.ts` 里裸写了 4 次、在
   * `sqlite/systemMaintenanceRetention.ts` 里另写了 4 次（且 SQLite 那 4 条走的是 `rowid`——
   * 这三张事件表的 `id` 就是 `INTEGER PRIMARY KEY AUTOINCREMENT`、即 rowid 别名，
   * `webhook_trigger_fires` 的 `id` 是 ULID 主键，按主键删与按 rowid 删选中的是同一批行）。
   */
  deleteByCandidates(table: SQLiteTable, idColumn: SQLiteColumn, candidates: SQL): SQL

  /**
   * 锁住聚合根，供「读—改—写」用。PG 渲染 `SELECT … FOR UPDATE`；SQLite no-op（已独占）。
   * **写法纪律**：读—改—写中间不锁的形状在 SQLite 上碰巧正确、在 PG 上是竞态——合一时必须改成
   * 先调这个，不能原样搬。
   */
  lockAggregateRoot(
    tx: DatabaseTransaction,
    table: SQLiteTable,
    idColumn: SQLiteColumn,
    id: string,
  ): Promise<void>

  /**
   * 队列式认领的锁子句，追加在 SELECT 末尾。PG：`for update skip locked`（多 worker 各拿各的、
   * 不互相等）；SQLite：空（独占事务下没有第二个认领者）。
   */
  claimLockClause(): SQL

  /** 事务级 advisory lock，跨进程协调用。PG：`pg_advisory_xact_lock`；SQLite no-op。 */
  advisoryLock(tx: DatabaseTransaction, key: string): Promise<void>

  /**
   * 手写 SQL 里 `FROM <table>` 之后的索引提示。SQLite：`INDEXED BY "<index>"`（让聚合扫覆盖索引而不是
   * 整表，RFC-311 的 repos 页刻度）；PG：空——planner 自己选，没有对应语法。
   */
  indexHint(indexName: string): SQL

  /**
   * 擦除凭据之后回收物理存储：SQLite 要 `secure_delete` + WAL truncate + `VACUUM`，否则旧页面里的密文
   * 还留在文件上；PG 由 autovacuum 负责，daemon 侧 no-op。**不能在事务里调**（VACUUM 拒绝事务内执行）。
   */
  reclaimScrubbedStorage(db: DatabaseTransaction): Promise<void>

  /**
   * 两个值里取大的那个。PG 是 `GREATEST(a, b)`，SQLite 是 `MAX(a, b)`——同一个语义、两个关键字，
   * 而且 SQLite 的 `MAX` 在**多参数**形态下才是标量函数（单参数是聚合），所以只能这样分方言写。
   * 典型用途：`onConflictDoUpdate` 里让游标只前进不后退（`MAX(旧值, excluded.新值)`）。
   */
  greatest(left: SQLWrapper, right: SQLWrapper): SQL

  /**
   * RFC-359 W6-T24 —— 取 JSON 文档**顶层某个成员的字符串值**。
   *
   * 闭合语义（`rfc359-w6-t24-json-member-text.test.ts` 的 19 格矩阵在两个引擎上各钉一遍）：
   * 文档为 NULL / 文档不是合法 JSON / 文档不是对象 / 成员缺失 / 成员是 JSON null /
   * 成员不是字符串（数字 / 布尔 / 数组 / 对象）⇒ 一律 NULL；只有「成员存在且是字符串」才给值。
   * 空字符串成员**照原样给回空串**——「空名字视同没有」是产品判据，留在调用方的 `NULLIF`。
   *
   * 为什么要进矩阵：PostgreSQL 侧的 `agent_workflow.json_extract` / `json_type` / `json_valid`
   * 是三个 **plpgsql + EXCEPTION 块**的 shim，而带 EXCEPTION 的 plpgsql 块每次调用都要开一个
   * 子事务——它是**逐行**付的。2026-09-07 真库实测（PostgreSQL 17.11，5 万行任务语料，
   * 单条 `count(表达式)`）：三个 shim 串起来 297ms，换成本条渲染的原生算子 91ms（3.2×）；
   * 换成真 jsonb 列只要 15ms（20×），但 jsonb 会改写存进去的字节，本仓的 json-text 列不允许
   * ——判据与证据见 `rfc359-w6-t23-json-column-storage.test.ts`。
   *
   * 渲染：
   *   · SQLite —— `json_valid` + `json_type` + `json_extract` 三个**内建 C 函数**，与本条落地前
   *     的查询文本逐字相同（所以 SQLite 侧不可能因这条改动而变慢）。
   *   · PostgreSQL —— `pg_input_is_valid(…, 'jsonb')`（PG 16+，无异常路径）守住 `::jsonb` 转换，
   *     再走原生 `->` / `->>`。**守卫必须写成嵌套 CASE，不能写成 `AND`**：PostgreSQL 明确不保证
   *     `AND` 的求值顺序（planner 会按代价重排），只有 `CASE` 才保证非法 JSON 上不去做那次转换。
   */
  jsonMemberText(document: SQLWrapper, member: string): SQL

  /** `ORDER BY col ASC`，按 SQLite 的 NULL 落位（NULL 最前）。 */
  ascNullsFirst(column: SQLWrapper): SQL
  /** `ORDER BY col DESC`，按 SQLite 的 NULL 落位（NULL 最后）。 */
  descNullsLast(column: SQLWrapper): SQL

  /** 用户输入的大小写不敏感搜索（ASCII 语义对齐；非 ASCII 折叠差异见对账 P1-28 备注）。 */
  likeCaseInsensitive(column: SQLWrapper, pattern: string, escape: string): SQL
  /** 把用户输入变成安全的 LIKE 模式；两侧都显式带 ESCAPE，消灭默认转义符差异。 */
  likeEscape(term: string): { readonly pattern: string; readonly escape: string }

  /** 裸 SQL 行里的数值列归一（PG 的 int8 经驱动是字符串）；非数值抛错而不是静默 NaN。 */
  numericFromRawRow(value: unknown, field: string): number

  /** 驱动错误 → 与引擎无关的分类。 */
  classifyError(error: unknown): EngineErrorClass

  /**
   * 唯一冲突撞上的是谁：PG 给约束名（`users_username_unique`），SQLite 给 `UNIQUE constraint failed:` 之后的
   * 列清单（`users.username`）；不是唯一冲突时 undefined。调用方用一条两边都认的正则判（`/users[._]username/`），
   * 把驱动冲突映射回自己的闭合错误合同——这是「驱动错误形状」这一类 provider 差异的唯一容身处。
   */
  uniqueViolationTarget(error: unknown): string | undefined

  /**
   * 同步读一行（不经事件循环）。SQLite 驱动本身同步：直接读文件，跨进程写者（CLI 建号 / 改权）立即可见；
   * PG 无法同步网络读，返回 undefined——调用方退回本进程缓存等替代面。返回 null 表示查到了但没有行。
   * 只给确实必须在当前 tick 判定的路径（RFC-305 的 WS 出站授权围栏）；别的读一律走异步。
   */
  readRowSync(db: ProviderNeutralDatabase, query: SQL): Record<string, unknown> | null | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎无关的部分（两个 provider 共用）
// ─────────────────────────────────────────────────────────────────────────────

const LIKE_ESCAPE = '\\'

/**
 * `jsonMemberText` 的成员名闭集。两个引擎的 JSON 取值都要把成员名嵌进 SQL 文本
 * （SQLite 是路径 `'$.name'`、PostgreSQL 是键 `'name'`），所以先把它收进一个**不需要转义**
 * 的字符集里再嵌，越界直接抛。判据与两个 shim 自己的路径正则同形
 * （`postgresqlSchema.ts` 的 `'^\\$\\.[A-Za-z_][A-Za-z0-9_]*$'`）。
 */
export function jsonMemberSqlLiterals(member: string): {
  readonly path: string
  readonly key: string
} {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(
      `jsonMemberText: 成员名必须匹配 [A-Za-z_][A-Za-z0-9_]*（要嵌进 SQL 文本），收到 ${JSON.stringify(member)}`,
    )
  }
  return { path: `'$.${member}'`, key: `'${member}'` }
}

/**
 * `batchInsertMax` 的**唯一**推导：参数预算 ÷ 每行列数，与引擎的行数甜点取小，下界 1 行
 * （宽到一行就吃光预算的表仍然写得进去——只是退化成逐行）。
 */
function batchInsertMaxRows(
  maxBindParameters: number,
  rowCap: number,
  columnCount: number,
): number {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new Error(`batchInsertMax needs a positive column count, got ${String(columnCount)}`)
  }
  return Math.max(1, Math.min(rowCap, Math.floor(maxBindParameters / columnCount)))
}

function escapeLikeTerm(term: string): string {
  // 先转义转义符本身，再转义两个通配符；顺序不能反。
  return term
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll('%', LIKE_ESCAPE + '%')
    .replaceAll('_', LIKE_ESCAPE + '_')
}

function likeEscape(term: string): { readonly pattern: string; readonly escape: string } {
  return { pattern: `%${escapeLikeTerm(term)}%`, escape: LIKE_ESCAPE }
}

function numericFromRawRow(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`raw row carried a non-numeric ${field}: ${String(value)}`)
  }
  return parsed
}

/** 沿 `cause` 链取某个字段（drizzle 会把驱动错误包成 DrizzleQueryError，原错误在 cause）。 */
function walkCause(error: unknown, pick: (node: object) => string | undefined): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const hit = pick(current)
    if (hit !== undefined) return hit
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

/** 沿 cause 链取第一个命中 pattern 的 message 的捕获组 1。 */
function firstMessageCapture(error: unknown, pattern: RegExp): string | undefined {
  return walkCause(error, (node) => {
    const message = (node as { readonly message?: unknown }).message
    if (typeof message !== 'string') return undefined
    return pattern.exec(message)?.[1]
  })
}

/** 沿 cause 链取第一个字符串 `code`（SQLite：`SQLITE_*`；PG 的 SQLSTATE 走 errno，另有判据）。 */
function codeOf(error: unknown): string | undefined {
  return walkCause(error, (node) => {
    const code = (node as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  })
}

/**
 * cause 链上**任一层**的 message 命中即为真。drizzle 把驱动错误包成 DrizzleError，外层 message
 * 只是「Failed to run the query…」——只看第一层永远看不到 SQLiteError 的正文（2026-09-04 实测）。
 */
function anyMessageMatches(error: unknown, pattern: RegExp): boolean {
  return (
    walkCause(error, (node) => {
      const message = (node as { readonly message?: unknown }).message
      return typeof message === 'string' && pattern.test(message) ? 'hit' : undefined
    }) === 'hit'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite
// ─────────────────────────────────────────────────────────────────────────────

const sqliteDialect = new SQLiteSyncDialect()

function classifySqliteError(error: unknown): EngineErrorClass {
  // 结构化优先：SQLiteError 带 `code`（SQLITE_CONSTRAINT_UNIQUE / SQLITE_BUSY*），它在 drizzle
  // 包装的 cause 里；外层 DrizzleError 没有 code。message 正则只作兜底，且逐层扫。
  const code = codeOf(error)
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return 'unique-violation'
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return 'busy'
  if (anyMessageMatches(error, /UNIQUE constraint failed/i)) return 'unique-violation'
  if (anyMessageMatches(error, /SQLITE_BUSY|database is locked/i)) return 'busy'
  return 'other'
}

export function createSqliteCapabilities(): EngineCapabilities {
  return Object.freeze({
    provider: 'sqlite',
    isolation: 'exclusive',
    maxBindParameters: SQLITE_MAX_BIND_PARAMETERS,
    batchInsertMax: (columnCount) =>
      batchInsertMaxRows(SQLITE_MAX_BIND_PARAMETERS, SQL_IN_CHUNK, columnCount),
    deleteByCandidates: (table, idColumn, candidates) =>
      sql`delete from ${table} where ${idColumn} in (${candidates}) returning ${idColumn} as ${sql.identifier('id')}`,
    async lockAggregateRoot() {
      // BEGIN IMMEDIATE 已独占整个库；行锁没有对应物，也不需要。
    },
    claimLockClause: () => sql``,
    async advisoryLock() {
      // 单进程单写者；跨进程协调由 daemon 级 flock 承担。
    },
    indexHint: (indexName) => sql`INDEXED BY ${sql.identifier(indexName)}`,
    greatest: (left, right) => sql`max(${left}, ${right})`,
    jsonMemberText: (document, member) => {
      // 三个都是 SQLite 内建 C 函数，逐行调用很便宜——这段与 RFC-357 落地时的查询文本
      // 逐字相同（只把 `IN ('text', 'string')` 收成 `= 'text'`：那个双拼法当初是因为
      // **同一段文本**要同时喂给 PostgreSQL 的 `jsonb_typeof` shim，现在每个引擎各渲染
      // 各的，SQLite 这侧只会看到自己的词汇表）。
      const { path } = jsonMemberSqlLiterals(member)
      return sql`CASE WHEN json_valid(${document}) THEN
        CASE WHEN json_type(${document}, ${sql.raw(path)}) = 'text'
          THEN json_extract(${document}, ${sql.raw(path)})
          ELSE NULL
        END
      ELSE NULL END`
    },
    async reclaimScrubbedStorage(db) {
      await db.run(sql`PRAGMA secure_delete = ON`)
      await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
      await db.run(sql`VACUUM`)
    },
    ascNullsFirst: (column) => sql`${column} asc`,
    descNullsLast: (column) => sql`${column} desc`,
    likeCaseInsensitive: (column, pattern, escape) =>
      sql`${column} like ${pattern} escape ${escape}`,
    likeEscape,
    numericFromRawRow,
    classifyError: classifySqliteError,
    uniqueViolationTarget: (error) =>
      classifySqliteError(error) === 'unique-violation'
        ? (firstMessageCapture(error, /UNIQUE constraint failed:\s*([^\n]+?)\s*$/) ?? '')
        : undefined,
    readRowSync: (db, query) => {
      const compiled = sqliteDialect.sqlToQuery(query)
      const row = (db as unknown as DbClient).$client
        .query(compiled.sql)
        .get(...(compiled.params as never[]))
      return (row as Record<string, unknown> | null | undefined) ?? null
    },
  } satisfies EngineCapabilities)
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

/** Bun.SQL 把 SQLSTATE 放在 `errno`；`code` 是 Node 风格的 ERR_* 常量。两处都看，沿 cause 链。 */
function postgresqlSqlState(error: unknown): string | undefined {
  return walkCause(error, (node) => {
    const errno = (node as { readonly errno?: unknown }).errno
    if (typeof errno === 'string' && /^[0-9A-Z]{5}$/.test(errno)) return errno
    const code = (node as { readonly code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    return undefined
  })
}

/**
 * 沿 cause 链找 PostgreSQL 唯一冲突（SQLSTATE 23505），命中返回约束名（可能为空串）。
 * **Bun.SQL 把 SQLSTATE 放在 `errno`**，`code` 恒为 `ERR_POSTGRES_SERVER_ERROR`（2026-09-04 真库实测：
 * `PostgresError{code:'ERR_POSTGRES_SERVER_ERROR', errno:'23505', constraint:'…'}`）。对账 F-I-13：
 * `isPostgresqlUniqueViolation` 此前只看 `code`，在真 PG 上恒 false ⇒ 并发同名拿 500 而非 409。
 * 本仓在 `postgresqlSerializationRetry.ts` 已按 errno 修好 40001，这里是同一判据的唯一冲突版。
 */
export function postgresqlUniqueViolationConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const node = current as {
      readonly errno?: unknown
      readonly code?: unknown
      readonly constraint?: unknown
      readonly cause?: unknown
    }
    if (node.errno === '23505' || node.code === '23505') {
      return typeof node.constraint === 'string' ? node.constraint : ''
    }
    current = node.cause
  }
  return undefined
}

export function createPostgresqlCapabilities(): EngineCapabilities {
  return Object.freeze({
    provider: 'postgresql',
    isolation: 'read-committed',
    maxBindParameters: POSTGRESQL_MAX_BIND_PARAMETERS,
    batchInsertMax: (columnCount) =>
      batchInsertMaxRows(POSTGRESQL_MAX_BIND_PARAMETERS, SQL_IN_CHUNK, columnCount),
    deleteByCandidates: (table, idColumn, candidates) =>
      sql`with candidates as (${candidates}) delete from ${table} using candidates where ${idColumn} = candidates.id returning ${idColumn} as ${sql.identifier('id')}`,
    async lockAggregateRoot(tx, table, idColumn, id) {
      await tx.run(sql`select 1 from ${table} where ${idColumn} = ${id} for update`)
    },
    claimLockClause: () => sql`for update skip locked`,
    async advisoryLock(tx, key) {
      await tx.run(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    },
    indexHint: () => sql``,
    greatest: (left, right) => sql`greatest(${left}, ${right})`,
    jsonMemberText: (document, member) => {
      // **嵌套 CASE，不是 `AND`**：PostgreSQL 不保证 `AND` 的子表达式求值顺序（planner 按
      // 代价重排），只有 `CASE` 保证「合法性判据为假时不去做那次 `::jsonb`」。写成
      // `pg_input_is_valid(...) AND ((...)::jsonb -> ...)` 在非法 JSON 行上会抛
      // `invalid input syntax for type json`。
      const { key } = jsonMemberSqlLiterals(member)
      return sql`CASE WHEN pg_input_is_valid(${document}, 'jsonb') THEN
        CASE WHEN jsonb_typeof((${document})::jsonb -> ${sql.raw(key)}) = 'string'
          THEN (${document})::jsonb ->> ${sql.raw(key)}
          ELSE NULL
        END
      ELSE NULL END`
    },
    async reclaimScrubbedStorage() {
      // PostgreSQL 由 autovacuum 回收页面；凭据单元格是事务内改写的，daemon 侧不做 VACUUM。
    },
    ascNullsFirst: (column) => sql`${column} asc nulls first`,
    descNullsLast: (column) => sql`${column} desc nulls last`,
    likeCaseInsensitive: (column, pattern, escape) =>
      sql`${column} ilike ${pattern} escape ${escape}`,
    likeEscape,
    numericFromRawRow,
    classifyError: (error) => {
      if (postgresqlSerializationFailureCode(error) !== undefined) return 'serialization'
      if (postgresqlUniqueViolationConstraint(error) !== undefined) return 'unique-violation'
      const state = postgresqlSqlState(error)
      if (state === '55P03') return 'busy' // lock_not_available（NOWAIT）
      return 'other'
    },
    uniqueViolationTarget: (error) => postgresqlUniqueViolationConstraint(error),
    // 网络驱动没有同步读；围栏类调用方退回本进程缓存（RFC-349 V1 的既有形态）。
    readRowSync: () => undefined,
  } satisfies EngineCapabilities)
}
