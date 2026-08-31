// RFC-349 — provider-aware doctor checks PostgreSQL-owned operational rows and
// never opens or describes the retained SQLite generation as live state.

import { afterEach, describe, expect, test } from 'bun:test'
import { checkPostgresqlLifecycleHealth, checkPostgresqlSealedCredentials } from '@/cli/doctor'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const savedHome = process.env.AGENT_WORKFLOW_HOME

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = savedHome
})

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

function runtimeFor(
  responder: (sql: string) => readonly Record<string, unknown>[],
): PostgresqlDatabaseRuntime {
  const pool = {
    unsafe(sql: string) {
      return rows(responder(sql))
    },
  } as PostgresqlPool
  return {
    provider: 'postgresql',
    generationId: 'dbg_pg_doctor_fixture_1234',
    providerPool: () => pool,
  } as PostgresqlDatabaseRuntime
}

describe('RFC-349 PostgreSQL doctor projections', () => {
  test('lifecycle health projects PostgreSQL counts through the existing wording', async () => {
    const runtime = runtimeFor((sql) => {
      expect(sql).toContain('agent_workflow.tasks')
      expect(sql).not.toMatch(/PRAGMA|sqlite/i)
      return [
        {
          interrupted: '3',
          failed: '1',
          awaiting_review: '2',
          awaiting_human: '0',
          quarantined: '1',
          open_alerts: '5',
        },
      ]
    })
    const result = await checkPostgresqlLifecycleHealth(runtime)
    expect(result).toMatchObject({ name: 'lifecycle', ok: true })
    expect(result.message).toContain('3 interrupted')
    expect(result.message).toContain('5 open alerts')
  })

  test('sealed-credential check reads the live PostgreSQL table and reports an empty set', async () => {
    const runtime = runtimeFor((sql) => {
      expect(sql).toContain('agent_workflow.cached_repos')
      expect(sql).not.toMatch(/PRAGMA|sqlite/i)
      return []
    })
    expect(await checkPostgresqlSealedCredentials(runtime)).toEqual({
      name: 'repo credentials',
      ok: true,
      message: 'no sealed credentials',
    })
  })
})
