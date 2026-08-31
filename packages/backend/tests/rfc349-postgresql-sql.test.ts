// RFC-349 T3/T4 — SQL compatibility is intentionally tiny: bind markers are
// token-aware and SQLite-only physical operations fail closed on PostgreSQL.

import { describe, expect, test } from 'bun:test'
import {
  assertPostgresqlBusinessStatement,
  compilePostgresqlSql,
  postgresqlStatementOperation,
  PostgresqlSqlCompatibilityError,
} from '@/platform/persistence/postgresqlSql'

describe('RFC-349 PostgreSQL SQL compiler', () => {
  test('numbers bind markers while preserving quoted/comment/dollar content', () => {
    expect(
      compilePostgresqlSql(
        `select ?, '?', "?", $$?$$, $tag$?$tag$ -- ?\n, ? /* ? */ from "agent_workflow"."tasks" where id = ?`,
      ),
    ).toBe(
      `select $1, '?', "?", $$?$$, $tag$?$tag$ -- ?\n, $2 /* ? */ from "agent_workflow"."tasks" where id = $3`,
    )
  })

  test('rejects every SQLite-only physical operation without echoing SQL payloads', () => {
    for (const statement of [
      'PRAGMA quick_check',
      ' vacuum ',
      "ATTACH DATABASE '/secret/path' AS x",
      'DETACH DATABASE x',
    ]) {
      try {
        compilePostgresqlSql(statement)
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(PostgresqlSqlCompatibilityError)
        expect(String(error)).not.toContain(statement)
      }
    }
  })

  test('fails closed on unterminated tokens', () => {
    expect(() => compilePostgresqlSql("select 'broken ?")).toThrow('unterminated quoted SQL token')
    expect(() => compilePostgresqlSql('select /* broken ?')).toThrow(
      'unterminated SQL block comment',
    )
    expect(() => compilePostgresqlSql('select $tag$ broken ?')).toThrow(
      'unterminated PostgreSQL dollar-quoted SQL token',
    )
  })

  test('classifies CTE writes for generation fencing and rejects business DDL', () => {
    expect(postgresqlStatementOperation('select 1')).toBe('read')
    expect(
      postgresqlStatementOperation(
        "WITH selected AS (SELECT id FROM users) UPDATE users SET status = 'active' WHERE id IN (SELECT id FROM selected)",
      ),
    ).toBe('write')
    expect(() => assertPostgresqlBusinessStatement('CREATE TABLE escaped (id text)')).toThrow(
      'provider migrator',
    )
  })
})
