// RFC-349 — the PostgreSQL admission lookup preserves repository > group >
// global precedence and returns the same provider-neutral revision content.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlDevelopmentAdmissionLookup } from '@/modules/development-automation/composition'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const COMPOSITION_SOURCE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'composition.ts',
)
const MISSION_OPERATIONS_SOURCE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'composition',
  'missionOperations.ts',
)
const SERVER_SOURCE = resolve(import.meta.dir, '..', 'src', 'server.ts')
const START_SOURCE = resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts')

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
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
    generationId: 'dbg_development_admission_pg',
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
    lookup: composePostgresqlDevelopmentAdmissionLookup(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL development admission lookup', () => {
  test('bootstrap injects one selected lookup into reconcile and HTTP launch', () => {
    const composition = readFileSync(COMPOSITION_SOURCE, 'utf8')
    const missionOperations = readFileSync(MISSION_OPERATIONS_SOURCE, 'utf8')
    const server = readFileSync(SERVER_SOURCE, 'utf8')
    const start = readFileSync(START_SOURCE, 'utf8')

    expect(composition).toContain(
      'const lookup = deps.admissionLookup ?? composeSqliteDevelopmentAdmissionLookup(deps.db)',
    )
    expect(missionOperations).toContain('lookup: deps.admissionLookup')
    expect(missionOperations).not.toContain('createSqliteAdmissionLookup')
    expect(server).toContain('admissionLookup: deps.developmentAdmissionLookup')
    expect(server).toContain('admissionLookup: runtimeDeps.developmentAdmissionLookup')
    expect(start).toContain(
      'const developmentAdmissionLookup = composeSqliteDevelopmentAdmissionLookup(db)',
    )
    expect(start).toContain('admissionLookup: developmentAdmissionLookup')
    expect(start).toContain('developmentAdmissionLookup,')
  })

  test('returns the repository assignment without consulting wider scopes', async () => {
    const fake = fixture([
      [['repository', 'employee-1', 3, 'selection-1', 4, 'execution-1', 5, 'gitlab-issue']],
    ])

    await expect(
      fake.lookup.resolveAssignment({
        repositoryId: 'repository-1',
        repositoryGroupId: 'group-1',
      }),
    ).resolves.toEqual({
      scopeKind: 'repository',
      employeeId: 'employee-1',
      employeeRevision: 3,
      selectionPolicyId: 'selection-1',
      selectionPolicyRevision: 4,
      executionPolicyId: 'execution-1',
      executionPolicyRevision: 5,
      defaultRequirementSourceKey: 'gitlab-issue',
    })
    expect(fake.executions).toHaveLength(1)
    expect(fake.executions[0]?.sql).toContain(
      'from "agent_workflow"."repository_employee_assignments"',
    )
    expect(fake.executions[0]?.parameters).toEqual(['repository', 'repository-1', 1])
  })

  test('falls through to group, then global default, in exact order', async () => {
    const group = fixture([
      [],
      [['repository-group', null, null, 'selection-2', 7, null, null, null]],
    ])
    await expect(
      group.lookup.resolveAssignment({
        repositoryId: 'repository-2',
        repositoryGroupId: 'group-2',
      }),
    ).resolves.toMatchObject({ scopeKind: 'repository-group', selectionPolicyRevision: 7 })
    expect(group.executions.map((execution) => execution.parameters?.[0])).toEqual([
      'repository',
      'repository-group',
    ])

    const global = fixture([
      [],
      [],
      [['global-default', 'employee-global', 2, null, null, null, null, null]],
    ])
    await expect(
      global.lookup.resolveAssignment({
        repositoryId: 'repository-3',
        repositoryGroupId: 'group-3',
      }),
    ).resolves.toMatchObject({ scopeKind: 'global-default', employeeId: 'employee-global' })
    expect(global.executions.map((execution) => execution.parameters?.[0])).toEqual([
      'repository',
      'repository-group',
      'global-default',
    ])
    expect(global.executions[2]?.sql).toContain('"scope_ref" is null')
  })

  test('reads published employee and policy revision contents and preserves missing', async () => {
    const fake = fixture([[['{"kind":"employee"}']], [['{"kind":"policy"}']], []])

    await expect(fake.lookup.getEmployeeRevisionContent('employee-1', 3)).resolves.toEqual({
      kind: 'employee',
    })
    await expect(fake.lookup.getPolicyRevisionContent('policy-1', 4)).resolves.toEqual({
      kind: 'policy',
    })
    await expect(fake.lookup.getPolicyRevisionContent('policy-missing', 1)).resolves.toBeNull()
    expect(fake.executions[0]?.sql).toContain('"digital_employee_revisions"')
    expect(fake.executions[1]?.sql).toContain('"automation_policy_revisions"')
  })
})
