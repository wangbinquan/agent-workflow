// RFC-349 — narrow compatibility compiler from Drizzle's provider-neutral
// logical query surface to PostgreSQL bind parameters. Provider-specific
// maintenance statements fail closed instead of accidentally reaching PG.

export class PostgresqlSqlCompatibilityError extends Error {
  constructor(
    public readonly code:
      | 'sqlite-operation-on-postgresql'
      | 'postgresql-ddl-through-business-client'
      | 'unterminated-sql-token',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlSqlCompatibilityError'
  }
}

export type PostgresqlStatementOperation = 'read' | 'write' | 'transaction' | 'ddl' | 'unknown'

const SQLITE_ONLY_STATEMENT = /^\s*(?:pragma\b|vacuum\b|attach\b|detach\b)/i
const ON_CONFLICT_TARGET = /\bon\s+conflict\s*\(([^()]*)\)/giu
const QUALIFIED_QUOTED_COLUMN = /(?:"(?:[^"]|"")*"\.)+"((?:[^"]|"")*)"/gu

function compilePostgresqlConflictTargets(sql: string): string {
  return sql.replace(ON_CONFLICT_TARGET, (clause, target: string) =>
    clause.replace(target, target.replace(QUALIFIED_QUOTED_COLUMN, '"$1"')),
  )
}

function dollarQuoteTag(sql: string, offset: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(offset))
  return match?.[0] ?? null
}

// Drizzle still produces fresh bindings before calling this compiler. Retain
// only successful text translations, with FIFO bounds on entries and combined
// input/output UTF-16 units; no client, statement or parameter state is stored.
const COMPILED_SQL_CACHE_MAX_ENTRIES = 256
const COMPILED_SQL_CACHE_MAX_UNITS = 524_288
const compiledSqlCache = new Map<string, string>()
let compiledSqlCacheUnits = 0

function retainCompiledSql(input: string, output: string): string {
  const units = input.length + output.length
  if (units > COMPILED_SQL_CACHE_MAX_UNITS) return output
  while (
    compiledSqlCache.size >= COMPILED_SQL_CACHE_MAX_ENTRIES ||
    compiledSqlCacheUnits + units > COMPILED_SQL_CACHE_MAX_UNITS
  ) {
    const oldest = compiledSqlCache.entries().next().value
    if (oldest === undefined) break
    compiledSqlCache.delete(oldest[0])
    compiledSqlCacheUnits -= oldest[0].length + oldest[1].length
  }
  compiledSqlCache.set(input, output)
  compiledSqlCacheUnits += units
  return output
}

/** Replace only SQLite bind markers, never question marks inside SQL tokens. */
export function compilePostgresqlSql(sql: string): string {
  if (SQLITE_ONLY_STATEMENT.test(sql)) {
    throw new PostgresqlSqlCompatibilityError(
      'sqlite-operation-on-postgresql',
      'SQLite-only database operation cannot run on PostgreSQL',
    )
  }

  const cached = compiledSqlCache.get(sql)
  if (cached !== undefined) return cached

  let output = ''
  let parameter = 0
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (char === "'" || char === '"') {
      const quote = char
      const start = index
      index += 1
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      if (sql[index - 1] !== quote) {
        throw new PostgresqlSqlCompatibilityError(
          'unterminated-sql-token',
          'unterminated quoted SQL token',
        )
      }
      output += sql.slice(start, index)
      continue
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2)
      const nextIndex = end < 0 ? sql.length : end + 1
      output += sql.slice(index, nextIndex)
      index = nextIndex
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end < 0) {
        throw new PostgresqlSqlCompatibilityError(
          'unterminated-sql-token',
          'unterminated SQL block comment',
        )
      }
      output += sql.slice(index, end + 2)
      index = end + 2
      continue
    }
    if (char === '$') {
      const tag = dollarQuoteTag(sql, index)
      if (tag !== null) {
        const end = sql.indexOf(tag, index + tag.length)
        if (end < 0) {
          throw new PostgresqlSqlCompatibilityError(
            'unterminated-sql-token',
            'unterminated PostgreSQL dollar-quoted SQL token',
          )
        }
        const nextIndex = end + tag.length
        output += sql.slice(index, nextIndex)
        index = nextIndex
        continue
      }
    }
    if (char === '?') {
      parameter += 1
      output += `$${parameter}`
      index += 1
      continue
    }
    output += char
    index += 1
  }
  // SQLite's Drizzle dialect qualifies ON CONFLICT target columns with their
  // table (and, for the provider projection, schema). PostgreSQL accepts
  // qualified columns elsewhere but requires conflict-target column names to
  // be unqualified. Keep this rewrite inside the provider compiler so owner
  // adapters can use one logical query shape without embedding PG syntax.
  return retainCompiledSql(sql, compilePostgresqlConflictTargets(output))
}

/** Classify only executable tokens, ignoring quoted text/comments/CTE bodies. */
export function postgresqlStatementOperation(sql: string): PostgresqlStatementOperation {
  const tokens: Array<{ readonly word: string; readonly depth: number }> = []
  let depth = 0
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (char === "'" || char === '"') {
      const quote = char
      index += 1
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2)
      index = end < 0 ? sql.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end < 0 ? sql.length : end + 2
      continue
    }
    if (char === '$') {
      const tag = dollarQuoteTag(sql, index)
      if (tag !== null) {
        const end = sql.indexOf(tag, index + tag.length)
        index = end < 0 ? sql.length : end + tag.length
        continue
      }
    }
    if (char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    const word = /^[A-Za-z]+/.exec(sql.slice(index))?.[0]
    if (word !== undefined) {
      tokens.push({ word: word.toUpperCase(), depth })
      index += word.length
      continue
    }
    index += 1
  }
  const first = tokens[0]?.word
  const operationWord =
    first === 'WITH'
      ? tokens.find(
          (token, tokenIndex) =>
            tokenIndex > 0 &&
            token.depth === 0 &&
            ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(token.word),
        )?.word
      : first
  if (operationWord === undefined) return 'unknown'
  if (['SELECT', 'VALUES', 'SHOW', 'EXPLAIN'].includes(operationWord)) return 'read'
  if (['INSERT', 'UPDATE', 'DELETE'].includes(operationWord)) return 'write'
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(operationWord)) {
    return 'transaction'
  }
  if (
    ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'REINDEX'].includes(
      operationWord,
    )
  ) {
    return 'ddl'
  }
  return 'unknown'
}

export function assertPostgresqlBusinessStatement(sql: string): PostgresqlStatementOperation {
  const operation = postgresqlStatementOperation(sql)
  if (operation === 'ddl') {
    throw new PostgresqlSqlCompatibilityError(
      'postgresql-ddl-through-business-client',
      'PostgreSQL schema operations must use the provider migrator, not the business client',
    )
  }
  return operation
}
