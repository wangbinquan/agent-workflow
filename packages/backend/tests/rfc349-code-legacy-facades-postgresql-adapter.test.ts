// RFC-349 — provider-neutral legacy code facades are backed by live
// PostgreSQL queries/writes, not a SQLite shadow or a cast client.
// RFC-395 BF-D27: AF-D1 marks once across writes and folds a later single-row insert.

import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
import { getTableColumns, type Table } from 'drizzle-orm'
import { nativeTableSets } from '@/bootstrap/persistenceSchema'
import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'

import type { CapabilityTemplateRecord } from '@/modules/code-capability/application/ports/capabilityTemplatePersistence'
import { createCapabilityParamRead } from '@/modules/code-capability/infrastructure/capabilityParamRead'
import { createCapabilityTemplatePersistence } from '@/modules/code-capability/infrastructure/capabilityTemplatePersistence'
import { createTaskCodeWorkspaceQueries } from '@/modules/task-execution/infrastructure/taskCodeWorkspaceQueries'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  const records = values.map((value) => ({ generation_id: value[0] })) as Array<
    Record<string, unknown>
  > & { count?: number }
  records.count = 1
  return Object.assign(Promise.resolve(records), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    const metadata = epoch2Metadata(sql, parameters)
    if (metadata) return metadata
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(sql)) return rows([])
    return rows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: run,
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_code_legacy_facades_pg',
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
  return {
    db: createPostgresqlDatabaseClient(runtime),
    executions,
    remaining: () => responses.length,
  }
}

function joinedRun(wrapperProgressJson: string | null): readonly unknown[] {
  const t = nativeTableSets.postgresql
  const values = (table: Table, fields: Record<string, unknown>) =>
    Object.keys(getTableColumns(table)).map((key) => fields[key] ?? null)
  return [
    ...values(t.nodeRuns, {
      id: 'run-1',
      taskId: 'task-1',
      nodeId: 'node',
      seq: 1,
      startedAt: 100,
      recordMode: 'executable',
      role: 'node-attempt',
      slotKey: '["rs1","node","node",null,0]',
      attemptIndex: 0,
      generationSeq: 1,
      iteration: 0,
      reviewIteration: 0,
      inputsRecorded: false,
      status: 'done',
    }),
    ...values(t.nodeRunConfigs, {}),
    ...values(t.nodeRunRuntimeStates, { nodeRunId: 'run-1', wrapperProgressJson }),
    ...values(t.nodeRunResults, {}),
    null,
    null, // optional frozen evidence content projection
  ]
}

describe('RFC-349 PostgreSQL code legacy-facade adapters', () => {
  test('cell parameters and workspace/node snapshots read PostgreSQL projections', async () => {
    const fake = fixture([
      [['[{"name":"limit","kind":"number"}]', '{"limit":2}', '{"limit":3}']],
      [['task-1', 'running', 'local', '/workspace', 'base-sha', null]],
      [
        ['', '/workspace', 'base-sha'],
        ['packages/api', '/workspace', 'api-sha'],
      ],
      // familyHistory projects run identity before the snapshot/checkpoint reads.
      [
        [
          'run-1',
          'task-1',
          'node',
          1,
          'done',
          '["rs1","node","node",null,0]',
          'node-attempt',
          'executable',
          0,
          0,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          100,
          null,
          null,
          false,
          false,
          1,
        ],
      ],
      [joinedRun(null)],
      [['run-1', '', 'pre-sha', null, null, null]],
      [],
      [joinedRun('{"baselineCommit":"wrapper-sha"}')],
      [['run-1', '', 'pre-sha', null, null, null]],
      [],
    ])
    const params = createCapabilityParamRead(fake.db)
    const workspace = createTaskCodeWorkspaceQueries(fake.db)

    await expect(params.find({ repoId: 'repo-1', capability: 'mr-review' })).resolves.toEqual({
      paramSchemaJson: '[{"name":"limit","kind":"number"}]',
      paramDefaultsJson: '{"limit":2}',
      paramsJson: '{"limit":3}',
    })
    await expect(workspace.findTask('task-1')).resolves.toMatchObject({
      id: 'task-1',
      repos: [
        { mountPath: '', worktreePath: '/workspace' },
        { mountPath: 'packages/api', worktreePath: '/workspace/packages/api' },
      ],
    })
    expect(await workspace.listNodeRuns('task-1')).toEqual([
      {
        seq: 1,
        id: 'run-1',
        checkpoints: [{ mountPath: '', preSnapshot: 'pre-sha' }],
        startedAt: 100,
        wrapperProgressJson: null,
      },
    ])
    await expect(workspace.findNodeRun('run-1')).resolves.toMatchObject({
      id: 'run-1',
      checkpoints: [{ mountPath: '', preSnapshot: 'pre-sha' }],
    })

    expect(fake.remaining()).toBe(0)
    const sql = fake.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'repo_capability_config',
      'capability_templates',
      'tasks',
      'task_repository_mounts',
      'node_run_runtime_states',
      'node_run_repo_checkpoints',
      'node_runs',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })

  test('capability-template writes execute against PostgreSQL', async () => {
    const fake = fixture([[], [], [], []])
    const persistence = createCapabilityTemplatePersistence(fake.db)
    const row: CapabilityTemplateRecord = {
      id: 'template-1',
      name: 'Template',
      description: null,
      capability: 'mr-review',
      scriptsJson: '{}',
      hooksJson: '[]',
      paramSchemaJson: '[]',
      paramDefaultsJson: '{}',
      agentBySlotJson: '{}',
      promptBySlotJson: '{}',
      paramsJson: '{}',
      stageContractVer: 1,
      ownerUserId: 'user-1',
      visibility: 'private',
      builtin: false,
      aclRevision: 0,
      upstreamId: null,
      upstreamVersion: null,
      baseDigest: null,
      baseSnapshotJson: null,
      createdAt: 100,
      updatedAt: 100,
    }

    await persistence.insert(row)
    await persistence.replace({ ...row, description: 'updated', updatedAt: 101 })
    await persistence.delete(row.id)

    const sql = fake.executions.map((entry) => entry.sql)
    const mutations = [
      'insert into "agent_workflow"."capability_templates"',
      'update "agent_workflow"."capability_templates"',
      'delete from "agent_workflow"."capability_templates"',
    ]
    expect(sql).toEqual(
      mutations.flatMap((mutation, index) => [
        'BEGIN',
        expect.stringMatching(/^SELECT generation_id .*"generations".*FOR SHARE$/i),
        ...(index === 0
          ? [
              expect.stringContaining('SELECT first_live_write_at'),
              expect.stringContaining('UPDATE "agent_workflow_meta"."first_write"'),
            ]
          : []),
        expect.stringContaining(mutation),
        'COMMIT',
      ]),
    )

    const foldedStart = fake.executions.length
    await persistence.insert({ ...row, id: 'template-2', name: 'Template 2' })
    const folded = fake.executions.slice(foldedStart)
    expect(folded.map((entry) => entry.sql)).toEqual([
      expect.stringMatching(/^insert into "agent_workflow"\."capability_templates" .* select /),
    ])
    expect(folded[0]?.sql).toContain(
      'where exists (select 1 from "agent_workflow_meta"."generations"',
    )
    expect(folded[0]?.sql).toContain("and state = 'active' for share)")
    expect(folded[0]?.parameters).toContain('template-2')
    expect(folded[0]?.parameters).toContain('dbg_code_legacy_facades_pg')
    expect(fake.remaining()).toBe(0)
  })
})
