import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
import { composeRetentionSweepPhases } from '@/bootstrap/retentionSweepPhases'
import { createTaskNodeEventArchiveStore } from '@/modules/task-execution/composition'
// RFC-349 T5/T6 — maintenance admission/lease transitions are Promise ports
// and PostgreSQL writes share the live-generation transaction fence.
// RFC-395 BF-D27: AF-D1 fences mutations and caches the first-write marker after commit.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { MAINTENANCE_WORKER_ENTRY } from '@/bootstrap/maintenanceWorkerEntries'
import { describe, expect, test } from 'bun:test'

import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { runRetentionSweepSlice } from '@/platform/persistence/sqlite/systemMaintenanceRetention'
import { createEventsArchiveMaintenanceCommand } from '@/platform/background/eventsArchiveMaintenance'
import { createTaskStatusCounts } from '@/modules/task-execution/composition'
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
  const epoch2Metadata = createEpoch2PostgresqlMetadata({ generationActive: () => fenceAccepted })
  const execute = (query: string): SqlRows => {
    statements.push(query)
    const metadata = epoch2Metadata(query)
    if (metadata) return metadata
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
    if (query.includes('generations')) {
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
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {
      releases += 1
    },
  })
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
    store: createMaintenanceRunStore(client),
    statements,
    get releases() {
      return releases
    },
  }
}

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
      workerEntry: MAINTENANCE_WORKER_ENTRY,
      appHome: '/provider-owned/application-home',
      databaseInit: {
        provider: 'postgresql',
        generationId: 'dbg_maintenance_pg',
        database: {
          provider: 'postgresql',
          urlEnv: 'RFC349_TEST_DATABASE_URL',
          poolMax: 8,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
      },
      workerFactory: () => worker,
      setTimer: () => Object.freeze({}),
      clearTimer() {},
    })

    expect(posted).toHaveLength(1)
    // RFC-359 AC-10 第十一波：**线格式没有变**。装配方交给监工的那一半叫 `databaseInit`，
    // 但监工是把它 spread 进 init 帧的——帧本身仍然是 protocol 里那个扁平的 strict 联合
    // （`MaintenanceWorkerInitSchema`）。这条断言锁的是**帧**，所以它必须保持扁平；
    // 如果这里跟着改成嵌套，就等于把一次「内部装配接缝」偷偷变成了一次协议变更。
    expect(posted[0]).toEqual({
      type: 'init',
      version: 1,
      catalogDigest: expect.any(String),
      appHome: '/provider-owned/application-home',
      provider: 'postgresql',
      generationId: 'dbg_maintenance_pg',
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
      'begin',
      expect.stringMatching(/^select generation_id .*"generations".*for share$/),
      expect.stringContaining('select first_live_write_at'),
      expect.stringContaining('update "agent_workflow_meta"."first_write"'),
      expect.stringContaining('update "agent_workflow"."maintenance_runs"'),
      'commit',
    ])
    expect(fake.releases).toBe(1)
  })

  test('subsequent heartbeats keep the fence and reuse the committed first-write marker', async () => {
    const fake = fixture()
    const heartbeat = { runId: 'run-1', leaseToken: 'lease-1', now: 100, leaseMs: 60_000 }
    await expect(fake.store.heartbeat(heartbeat)).resolves.toBe(true)
    const secondWriteStart = fake.statements.length

    await expect(fake.store.heartbeat({ ...heartbeat, now: 101 })).resolves.toBe(true)

    const normalized = fake.statements.map((statement) => statement.trim().toLowerCase())
    expect(normalized.slice(secondWriteStart)).toEqual([
      'begin',
      expect.stringMatching(/^select generation_id .*"generations".*for share$/),
      expect.stringContaining('update "agent_workflow"."maintenance_runs"'),
      'commit',
    ])
    expect(normalized.filter((statement) => statement.includes('"first_write"'))).toEqual([
      expect.stringContaining('select first_live_write_at'),
      expect.stringContaining('update "agent_workflow_meta"."first_write"'),
    ])
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
    expect(fake.releases).toBe(1)
  })

  test('health projection executes through the PostgreSQL provider client', async () => {
    const fake = fixture()

    await expect(createTaskStatusCounts(fake.client).countRunningTasks()).resolves.toBe(3)

    expect(fake.statements.at(-1)).toContain('"agent_workflow"."tasks"')
  })

  test('retention deletes one bounded PostgreSQL slice behind the generation fence', async () => {
    const statements: string[] = []
    const epoch2Metadata = createEpoch2PostgresqlMetadata()
    const execute = (query: string): SqlRows => {
      statements.push(query)
      const metadata = epoch2Metadata(query)
      if (metadata) return metadata
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
      if (query.includes('generations')) {
        return rows({ objects: [{ generation_id: 'dbg_maintenance_pg' }] })
      }
      if (/delete\s+from\s+"agent_workflow"\."memory_distill_events"/is.test(query)) {
        return rows({ objects: [{ id: 'event-1' }] })
      }
      throw new Error(`unexpected PostgreSQL retention query: ${query}`)
    }
    const connection: PostgresqlReservedConnection = withNativeTransactions({
      unsafe: execute,
      release() {},
    })
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

    // RFC-359 W57：PG 侧的孪生 `runPostgresqlRetentionSweepSlice` 已删（与这一份逐字相同）。
    // 这条用例仍是有价值的：它用**假 pool** 断言这一份实现在 PostgreSQL 客户端上发出的
    // 语句形状（`WITH candidates AS (…) DELETE … USING candidates`）与游标推进。
    const result = await runRetentionSweepSlice(
      composeRetentionSweepPhases(createPostgresqlDatabaseClient(runtime)),
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
      'begin',
      expect.stringMatching(/^select generation_id .*"generations".*for share$/),
      expect.stringContaining('select first_live_write_at'),
      expect.stringContaining('update "agent_workflow_meta"."first_write"'),
      expect.stringContaining('with candidates'),
      'commit',
    ])
  })

  test('event archive counts by bounded PostgreSQL windows and fences deletion', async () => {
    const statements: string[] = []
    const epoch2Metadata = createEpoch2PostgresqlMetadata()
    const execute = (query: string): SqlRows => {
      statements.push(query)
      const metadata = epoch2Metadata(query)
      if (metadata) return metadata
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows({})
      if (query.includes('generations')) {
        return rows({ objects: [{ generation_id: 'dbg_maintenance_pg' }] })
      }
      if (/select\s+max\(/is.test(query)) return rows({ values: [[300_001]] })
      if (/select\s+count\(/is.test(query)) return rows({ values: [[7]] })
      if (/delete\s+from\s+"agent_workflow"\."node_run_events"/is.test(query)) {
        return rows({ objects: [] })
      }
      throw new Error(`unexpected PostgreSQL event-archive query: ${query}`)
    }
    const connection: PostgresqlReservedConnection = withNativeTransactions({
      unsafe: execute,
      release() {},
    })
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
    const store = createTaskNodeEventArchiveStore(createPostgresqlDatabaseClient(runtime))

    await expect(
      createEventsArchiveMaintenanceCommand({
        store,
        logsDir: '/archive-not-reached-during-count',
      }).runSlice({
        thresholds: {
          perNodeRunRows: 5_000,
          globalRows: 1_000_000,
          perNodeRunBytes: 0,
          globalBytes: 0,
        },
      }),
    ).resolves.toEqual({
      counters: { countedRows: 7 },
      delta: { kind: 'none' },
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

    const deletionStart = statements.length
    await store.deleteNodeRunEventsThrough('run-1', 50)
    const fencedDelete = statements.slice(deletionStart).map((statement) => statement.trim())
    expect(fencedDelete).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT generation_id .*"generations".*FOR SHARE$/i),
      expect.stringContaining('SELECT first_live_write_at'),
      expect.stringContaining('UPDATE "agent_workflow_meta"."first_write"'),
      expect.stringContaining('delete from "agent_workflow"."node_run_events"'),
      'COMMIT',
    ])
    const deletion = fencedDelete.find((statement) => /delete\s+from/i.test(statement))
    expect(deletion).not.toContain('rowid')
  })
})
