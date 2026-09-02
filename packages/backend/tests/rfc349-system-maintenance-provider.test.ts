// RFC-349 T5/T6 — maintenance admission/lease transitions are Promise ports
// and PostgreSQL writes share the live-generation transaction fence.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlMaintenanceRunStore } from '@/platform/persistence/postgresqlMaintenanceRunStore'
import { runPostgresqlRetentionSweepSlice } from '@/platform/persistence/postgresqlMaintenanceRetention'
import {
  createPostgresqlEventsArchiveStore,
  runPostgresqlEventsArchiveSlice,
} from '@/platform/persistence/postgresqlEventsArchive'
import { createPostgresqlHealthDatabaseReadModel } from '@/modules/system-operations/infrastructure/postgresqlHealthReadModel'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'

function rows(input: {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
}): SqlRows {
  return Object.assign(Promise.resolve(input.objects ?? []), {
    async values() {
      return input.values ?? []
    },
  })
}

function fixture(fenceAccepted = true) {
  const statements: string[] = []
  let releases = 0
  const execute = (query: string): SqlRows => {
    statements.push(query)
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
    if (query.includes('database_generations')) {
      return rows({
        objects: fenceAccepted ? [{ generation_id: 'dbg_maintenance_pg' }] : [],
      })
    }
    if (/select\s+count\(\*\).*from\s+"agent_workflow"\."tasks"/is.test(query)) {
      return rows({ values: [[3]] })
    }
    if (/update\s+"agent_workflow"\."maintenance_runs"/i.test(query)) {
      return rows({ values: [['run-1']] })
    }
    throw new Error(`unexpected PostgreSQL maintenance query: ${query}`)
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_maintenance_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  const client = createPostgresqlDatabaseClient(runtime)
  return {
    client,
    store: createPostgresqlMaintenanceRunStore(client),
    statements,
    get releases() {
      return releases
    },
  }
}

afterEach(() => selectDatabaseSchemaProvider('sqlite'))

describe('RFC-349 PostgreSQL maintenance persistence', () => {
  test('worker bootstrap carries a secret-free PostgreSQL provider descriptor', () => {
    const posted: unknown[] = []
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(message: unknown) {
        posted.push(message)
      },
      terminate() {},
    }

    startMaintenanceWorkerSupervisor({
      provider: 'postgresql',
      generationId: 'dbg_maintenance_pg',
      appHome: '/provider-owned/application-home',
      database: {
        provider: 'postgresql',
        urlEnv: 'RFC349_TEST_DATABASE_URL',
        poolMax: 8,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
      },
      workerFactory: () => worker,
      setTimer: () => Object.freeze({}),
      clearTimer() {},
    })

    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual({
      type: 'init',
      version: 1,
      catalogDigest: expect.any(String),
      provider: 'postgresql',
      generationId: 'dbg_maintenance_pg',
      appHome: '/provider-owned/application-home',
      database: {
        provider: 'postgresql',
        urlEnv: 'RFC349_TEST_DATABASE_URL',
        poolMax: 8,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
      },
    })
    expect(JSON.stringify(posted)).not.toContain('postgresql://')
  })

  test('heartbeats through one fenced provider transaction', async () => {
    const fake = fixture()

    await expect(
      fake.store.heartbeat({
        runId: 'run-1',
        leaseToken: 'lease-1',
        now: 100,
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true)

    expect(fake.statements.map((statement) => statement.trim().toLowerCase())).toEqual([
      // The one-shot live-write marker commits on its own reserved session,
      // ahead of the transaction it belongs to.
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      'begin',
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('update "agent_workflow"."maintenance_runs"'),
      'commit',
    ])
    // +1 reserved session: the one-shot RFC-349 live-write marker.
    expect(fake.releases).toBe(2)
  })

  test('rejects a stale generation before the lease row mutates', async () => {
    const fake = fixture(false)

    await expect(
      fake.store.heartbeat({
        runId: 'run-1',
        leaseToken: 'lease-1',
        now: 100,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow('Failed query')

    expect(fake.statements.some((statement) => statement.includes('maintenance_runs'))).toBe(false)
    expect(fake.statements.at(-1)?.trim().toLowerCase()).toBe('rollback')
    // +1 reserved session: the one-shot RFC-349 live-write marker.
    expect(fake.releases).toBe(2)
  })

  test('health projection executes through the PostgreSQL provider client', async () => {
    const fake = fixture()

    await expect(
      createPostgresqlHealthDatabaseReadModel(fake.client).countRunningTasks(),
    ).resolves.toBe(3)

    expect(fake.statements.at(-1)).toContain('"agent_workflow"."tasks"')
  })

  test('retention deletes one bounded PostgreSQL slice behind the generation fence', async () => {
    const statements: string[] = []
    const execute = (query: string): SqlRows => {
      statements.push(query)
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
      if (query.includes('database_generations')) {
        return rows({ objects: [{ generation_id: 'dbg_maintenance_pg' }] })
      }
      if (/delete\s+from\s+"agent_workflow"\."memory_distill_events"/is.test(query)) {
        return rows({ objects: [{ id: 'event-1' }] })
      }
      throw new Error(`unexpected PostgreSQL retention query: ${query}`)
    }
    const connection: PostgresqlReservedConnection = {
      unsafe: execute,
      release() {},
    }
    const pool: PostgresqlPool = {
      async reserve() {
        return connection
      },
      unsafe: execute,
      async close() {},
    }
    const runtime: PostgresqlDatabaseRuntime = {
      provider: 'postgresql',
      generationId: 'dbg_maintenance_pg',
      async health() {
        throw new Error('not used')
      },
      async readiness() {
        throw new Error('not used')
      },
      async acquireMigrationAdvisoryLock() {
        throw new Error('not used')
      },
      providerPool: () => pool,
      async close() {},
    }

    const result = await runPostgresqlRetentionSweepSlice(
      createPostgresqlDatabaseClient(runtime),
      { eventStreamRetentionDays: 30, webhookTriggerFiresRetentionDays: 0 },
      undefined,
      3_000_000_000,
      1_000,
    )

    expect(result).toEqual({
      done: false,
      cursor: {
        version: 1,
        phase: 'intent-turn-events',
        eventCutoff: 408_000_000,
        webhookCutoff: null,
      },
      counters: {
        distillEvents: 1,
        intentTurnEvents: 0,
        mcpRuntimeTestEvents: 0,
        webhookTriggerFires: 0,
        userAccessAudit: 0,
      },
    })
    const deleteStatement = statements.find((statement) => /delete\s+from/i.test(statement))
    expect(deleteStatement).toContain('"agent_workflow"."memory_distill_events"')
    expect(deleteStatement).not.toContain('rowid')
    expect(statements.map((statement) => statement.trim().toLowerCase())).toEqual([
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      'begin',
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('with candidates'),
      'commit',
    ])
  })

  test('event archive counts by bounded PostgreSQL windows and fences deletion', async () => {
    const statements: string[] = []
    const execute = (query: string): SqlRows => {
      statements.push(query)
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
      if (query.includes('database_generations')) {
        return rows({ objects: [{ generation_id: 'dbg_maintenance_pg' }] })
      }
      if (/select\s+max\(/is.test(query)) return rows({ values: [[300_001]] })
      if (/select\s+count\(/is.test(query)) return rows({ values: [[7]] })
      if (/delete\s+from\s+"agent_workflow"\."node_run_events"/is.test(query)) {
        return rows({ objects: [] })
      }
      throw new Error(`unexpected PostgreSQL event-archive query: ${query}`)
    }
    const connection: PostgresqlReservedConnection = {
      unsafe: execute,
      release() {},
    }
    const pool: PostgresqlPool = {
      async reserve() {
        return connection
      },
      unsafe: execute,
      async close() {},
    }
    const runtime: PostgresqlDatabaseRuntime = {
      provider: 'postgresql',
      generationId: 'dbg_maintenance_pg',
      async health() {
        throw new Error('not used')
      },
      async readiness() {
        throw new Error('not used')
      },
      async acquireMigrationAdvisoryLock() {
        throw new Error('not used')
      },
      providerPool: () => pool,
      async close() {},
    }
    const store = createPostgresqlEventsArchiveStore(createPostgresqlDatabaseClient(runtime))

    await expect(
      runPostgresqlEventsArchiveSlice({
        store,
        config: {
          eventsArchiveThresholds: {
            perNodeRunRows: 5_000,
            globalRows: 1_000_000,
            perNodeRunBytes: 0,
            globalBytes: 0,
          },
        },
        logsDir: '/archive-not-reached-during-count',
      }),
    ).resolves.toEqual({
      counters: { countedRows: 7 },
      continuation: {
        cursor: {
          version: 1,
          phase: 'count',
          maxId: 300_001,
          scanFrom: 250_000,
          totalRows: 7,
        },
        resumeAfterMs: 25,
      },
    })

    await store.deleteNodeRunEventsThrough('run-1', 50)
    const deleteIndex = statements.findIndex((statement) => /delete\s+from/i.test(statement))
    expect(deleteIndex).toBeGreaterThan(0)
    const fencedDelete = statements
      .slice(deleteIndex - 2, deleteIndex + 2)
      .map((statement) => statement.trim())
    expect(fencedDelete[0]).toBe('BEGIN')
    expect(fencedDelete[1]).toContain('SELECT generation_id FROM "agent_workflow_meta"')
    expect(fencedDelete[2]?.toLowerCase()).toContain(
      'delete from "agent_workflow"."node_run_events"',
    )
    expect(fencedDelete[3]).toBe('COMMIT')
    expect(statements[deleteIndex]).not.toContain('rowid')
  })
})
