// RFC-349 — provider-neutral legacy code facades are backed by live
// PostgreSQL queries/writes, not a SQLite shadow or a cast client.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { CapabilityTemplateRecord } from '@/modules/code-capability/application/ports/capabilityTemplatePersistence'
import { createPostgresqlCapabilityParamRead } from '@/modules/code-capability/infrastructure/postgresqlCapabilityParamRead'
import { createPostgresqlCapabilityTemplatePersistence } from '@/modules/code-capability/infrastructure/postgresqlCapabilityTemplatePersistence'
import { createPostgresqlCodeWorkspaceRead } from '@/modules/code-capability/infrastructure/postgresqlCodeWorkspaceRead'
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
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    // RFC-349: the one-shot live-write marker and the per-transaction
    // generation fence are infrastructure, not part of the adapter contract
    // each case queues responses for. Answer them without consuming the queue.
    if (sql.includes('database_generations')) return rows([['dbg_code_legacy_pg']])
    return rows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
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
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL code legacy-facade adapters', () => {
  test('cell parameters and workspace/node snapshots read PostgreSQL projections', async () => {
    const fake = fixture([
      [['[{"name":"limit","kind":"number"}]', '{"limit":2}', '{"limit":3}']],
      [['task-1', 'running', 'local', '/workspace', 'base-sha', 2]],
      [
        ['', '', '/workspace', 'base-sha'],
        ['packages/api', 'api', '/workspace/packages/api', 'api-sha'],
      ],
      [['run-1', 'pre-sha', null, 100, null]],
      [['run-1', 'pre-sha', null, 100, '{"baselineCommit":"wrapper-sha"}']],
    ])
    const params = createPostgresqlCapabilityParamRead(fake.db)
    const workspace = createPostgresqlCodeWorkspaceRead(fake.db)

    await expect(params.find({ repoId: 'repo-1', capability: 'mr-review' })).resolves.toEqual({
      paramSchemaJson: '[{"name":"limit","kind":"number"}]',
      paramDefaultsJson: '{"limit":2}',
      paramsJson: '{"limit":3}',
    })
    await expect(workspace.findTask('task-1')).resolves.toMatchObject({
      id: 'task-1',
      repoCount: 2,
      repos: [
        { mountPath: '', worktreePath: '/workspace' },
        { mountPath: 'packages/api', worktreePath: '/workspace/packages/api' },
      ],
    })
    await expect(workspace.listNodeRuns('task-1')).resolves.toEqual([
      {
        id: 'run-1',
        preSnapshot: 'pre-sha',
        preSnapshotReposJson: null,
        startedAt: 100,
        wrapperProgressJson: null,
      },
    ])
    await expect(workspace.findNodeRun('run-1')).resolves.toMatchObject({ id: 'run-1' })

    const sql = fake.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'repo_capability_config',
      'capability_templates',
      'tasks',
      'task_repos',
      'node_runs',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })

  test('capability-template writes execute against PostgreSQL', async () => {
    const fencedWrite = [[], [['dbg_code_legacy_facades_pg']], [], []] as const
    const fake = fixture([...fencedWrite, ...fencedWrite, ...fencedWrite])
    const persistence = createPostgresqlCapabilityTemplatePersistence(fake.db)
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

    // begin/marker/fence/write/commit for the first write, begin/fence/write/
    // commit for the two that follow — the marker is one-shot per process.
    expect(fake.executions).toHaveLength(13)
    expect(fake.executions[0]?.sql).toContain('WITH marked AS (UPDATE "agent_workflow_meta"')
    expect(fake.executions[2]?.sql).toContain('SELECT generation_id FROM "agent_workflow_meta"')
    expect(fake.executions[3]?.sql).toContain('insert into "agent_workflow"."capability_templates"')
    expect(fake.executions[7]?.sql).toContain('update "agent_workflow"."capability_templates"')
    expect(fake.executions[11]?.sql).toContain(
      'delete from "agent_workflow"."capability_templates"',
    )
  })
})
