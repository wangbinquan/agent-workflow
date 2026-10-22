// RFC-395 I-b: native PostgreSQL rendering owns placeholders/conflicts; the client classifier never rewrites SQL.
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { nativeQueryFixture } from './helpers/nativeQueryFixture'
import {
  assertPostgresqlBusinessStatement,
  postgresqlStatementOperation,
  PostgresqlSqlCompatibilityError,
} from '@/platform/persistence/postgresqlSql'

describe('RFC-349 PostgreSQL native SQL and statement classification', () => {
  test('numbers AST bindings while preserving quoted/comment/dollar content', () => {
    const literal = `, '?', "?", $$?$$, $tag$?$tag$ -- ?\n, `
    const query = new PgDialect().sqlToQuery(
      sql`select ${1}${sql.raw(literal)}${2} /* ? */ from "agent_workflow"."tasks" where id = ${'task'}`,
    )
    expect(query.sql).toBe(
      `select $1, '?', "?", $$?$$, $tag$?$tag$ -- ?\n, $2 /* ? */ from "agent_workflow"."tasks" where id = $3`,
    )
    expect(query.params).toEqual([1, 2, 'task'])
  })
  test('native upserts render unqualified conflict targets and retain fresh bindings', () => {
    const {
      db,
      tables: { employeeOsSettings },
    } = nativeQueryFixture('postgresql')
    const query = db
      .insert(employeeOsSettings)
      .values({ singletonKey: 'global', updatedAt: 1, executionPolicyRevision: 1 })
      .onConflictDoUpdate({ target: employeeOsSettings.singletonKey, set: { updatedAt: 2 } })
      .toSQL()
    expect(query.sql).toContain('insert into "agent_workflow"."employee_os_settings"')
    expect(query.sql).toContain('on conflict ("singleton_key") do update set "updated_at" = ')
    expect(query.params.at(-1)).toBe(2)
  })
  test('rejects every SQLite-only physical operation before driver dispatch', () => {
    for (const statement of [
      'PRAGMA quick_check',
      ' vacuum ',
      "ATTACH DATABASE '/secret/path' AS x",
      'DETACH DATABASE x',
    ]) {
      try {
        assertPostgresqlBusinessStatement(statement)
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(PostgresqlSqlCompatibilityError)
        expect(String(error)).not.toContain(statement)
      }
    }
  })
  test('quoted and incomplete text is not rewritten or treated as a business write', () => {
    for (const text of [
      "select 'insert into t'",
      'select $$update t$$',
      "select 'broken ?",
      'select /* broken ?',
      'select $tag$ broken ?',
    ]) {
      expect(postgresqlStatementOperation(text)).toBe('read')
      expect(new PgDialect().sqlToQuery(sql.raw(text)).sql).toBe(text)
    }
  })
  test('classifies CTE writes and native transaction boundaries, and rejects business DDL', () => {
    expect(postgresqlStatementOperation('select 1')).toBe('read')
    expect(
      postgresqlStatementOperation(
        "WITH selected AS (SELECT id FROM users) UPDATE users SET status = 'active' WHERE id IN (SELECT id FROM selected)",
      ),
    ).toBe('write')
    for (const text of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT one', 'RELEASE SAVEPOINT one'])
      expect(postgresqlStatementOperation(text)).toBe('transaction')
    expect(() => assertPostgresqlBusinessStatement('CREATE TABLE escaped (id text)')).toThrow(
      'provider migrator',
    )
  })
})
