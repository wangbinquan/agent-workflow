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
//   · NULL 排序：`postgresqlNullOrdering.ts`（两引擎默认正好相反；认领类查询会因此饿死）
//   · LIKE 大小写：`rfc349-provider-search-case-parity`（SQLite ASCII 不敏感 / PG 敏感 ⇒ ilike）
//   · LIKE 转义符：本轮对账 P1-28（SQLite 无默认转义符 / PG 默认是 `\`；两侧都显式带 ESCAPE 才一致）
//   · 裸行数值归一：RFC-357 `taskListPage/projection.ts`（PG 的 int8 经驱动回来是字符串）
//   · 错误分类：`postgresqlSerializationRetry.ts` 的 `errno` 判据——Bun.SQL 把 SQLSTATE 放在
//     `errno`，`code` 恒为 ERR_POSTGRES_SERVER_ERROR。本轮对账 F-I-13 发现
//     `isPostgresqlUniqueViolation` 只看 `code`，在真 PG 上恒为 false ⇒ 并发同名拿 500 而非 409。
//   · 行锁与 advisory lock：`postgresqlTaskLifecycleTransaction.ts:100` 与
//     `platform/events/committed/postgresqlPersistence.ts:230` 的既有写法。
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
import type { DatabaseTransaction } from './databaseTransaction'

export type EngineErrorClass = 'unique-violation' | 'serialization' | 'busy' | 'other'

export interface EngineCapabilities {
  /** 只供矩阵自身的测试与诊断日志读；业务代码读它就是分叉，W5 守卫会红。 */
  readonly provider: DatabaseProvider
  /** 事务体看到的隔离形态：PG 是多写并发（须显式行锁）；SQLite 在 BEGIN IMMEDIATE 下独占。 */
  readonly isolation: 'read-committed' | 'exclusive'
  /** 一条语句可带的绑定参数上限；批量写按它切批。 */
  readonly maxBindParameters: number

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
    maxBindParameters: 32_766,
    async lockAggregateRoot() {
      // BEGIN IMMEDIATE 已独占整个库；行锁没有对应物，也不需要。
    },
    claimLockClause: () => sql``,
    async advisoryLock() {
      // 单进程单写者；跨进程协调由 daemon 级 flock 承担。
    },
    indexHint: (indexName) => sql`INDEXED BY ${sql.identifier(indexName)}`,
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
    maxBindParameters: 65_535,
    async lockAggregateRoot(tx, table, idColumn, id) {
      await tx.run(sql`select 1 from ${table} where ${idColumn} = ${id} for update`)
    },
    claimLockClause: () => sql`for update skip locked`,
    async advisoryLock(tx, key) {
      await tx.run(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    },
    indexHint: () => sql``,
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
