// RFC-349 — Integration provider adapters keep verified-ingress dedupe and
// MR launch admission atomic while exposing one Promise application contract.

import { afterEach, describe, expect, test } from 'bun:test'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import type { Actor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type {
  ScheduledTaskCreateRecord,
  ScheduledTaskPersistencePort,
} from '@/modules/integration/application/ports/scheduledTaskPersistence'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { IntegrationTriggerResourceRequest } from '@/modules/resource-catalog/public/types'
import { createPostgresqlMrLaunchGuardPersistence } from '@/modules/integration/infrastructure/postgresqlMrTerminalControlPersistence'
import { createPostgresqlIntegrationTriggerResources } from '@/modules/integration/infrastructure/postgresqlIntegrationTriggerResources'
import { createPostgresqlScheduledTaskPersistence } from '@/modules/integration/infrastructure/postgresqlScheduledTaskPersistence'
import { createPostgresqlWebhookTerminalWorkspaceAttributionQueries } from '@/modules/integration/infrastructure/postgresqlTerminalWorkspaceAttribution'
import { createPostgresqlVerifiedWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/postgresqlVerifiedWebhookDeliveryPersistence'
import { createPostgresqlWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/postgresqlWebhookDeliveryPersistence'
import { createSqliteScheduledTaskPersistence } from '@/modules/integration/infrastructure/sqliteScheduledTaskPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'

interface Response {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function rows(response: Response): SqlRows {
  const objects = [...(response.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = response.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return response.values ?? []
    },
  })
}

function fixture(responses: Array<Response | Error>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  let releases = 0
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    const response = responses.shift() ?? {}
    if (response instanceof Error) throw response
    return rows(response)
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: run,
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_integration_pg',
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
    get releases() {
      return releases
    },
  }
}

function mrEvent(): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: 'provider-event-1',
    eventType: 'mr_updated',
    repoPath: 'group/repo',
    repoHttpUrl: 'https://example.test/group/repo.git',
    repoSshUrl: 'git@example.test:group/repo.git',
    projectId: '77',
    mrIid: '9',
    author: {},
    raw: {},
  }
}

const scheduledRecord: ScheduledTaskCreateRecord = Object.freeze({
  id: 'schedule-1',
  name: 'fixture schedule',
  ownerUserId: 'owner-1',
  launchKind: 'agent',
  launchPayload: '{"agentId":"agent-1"}',
  scheduleSpec: '{"kind":"interval","everyMs":60000}',
  enabled: true,
  nextRunAt: 500,
  consecutiveFailures: 0,
  createdAt: 100,
  updatedAt: 100,
})

const scheduledOwner: Actor = Object.freeze({
  user: Object.freeze({
    id: scheduledRecord.ownerUserId,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  }),
  source: 'session',
  permissions: new Set(['scheduled-tasks:read'] as const),
})

const integrationTriggerRequest = Object.freeze({
  kind: 'webhook-digital-employee' as const,
  employeeDefinitionId: 'employee-1',
})

const integrationTriggerSnapshot = Object.freeze({
  kind: 'webhook-digital-employee' as const,
  employee: Object.freeze({
    employeeDefinitionId: 'employee-1',
    currentRevision: 3,
    typeId: 'developer',
    typeRevision: 2,
    intake: Object.freeze({ acceptedKinds: Object.freeze(['body' as const]), targetFields: [] }),
  }),
})

async function assertScheduledCreateBehavior(
  persistence: ScheduledTaskPersistencePort,
): Promise<void> {
  let finishedWithExactSnapshot = false
  const created = await persistence.createAtomically({
    record: scheduledRecord,
    authority: { authority: Object.freeze({}), actor: Object.freeze({}) } as never,
    request: integrationTriggerRequest,
    finish(snapshot) {
      finishedWithExactSnapshot = snapshot === integrationTriggerSnapshot
      return scheduledRecord
    },
  })
  expect(finishedWithExactSnapshot).toBe(true)
  expect(created).toMatchObject({
    id: scheduledRecord.id,
    ownerUserId: scheduledRecord.ownerUserId,
    launchKind: scheduledRecord.launchKind,
    nextRunAt: scheduledRecord.nextRunAt,
    aclRevision: 0,
  })
  await expect(persistence.countVisible(scheduledOwner)).resolves.toBe(1)
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Integration provider adapters', () => {
  test('scheduled-task atomic create has one behavior oracle for SQLite and PostgreSQL', async () => {
    const sqlite = createInMemoryDb(MIGRATIONS)
    try {
      let sqliteResourceLoads = 0
      await assertScheduledCreateBehavior(
        createSqliteScheduledTaskPersistence(sqlite, {
          inTransaction(_transaction, pair) {
            return {
              loadAuthorized(
                authority: ResourceRequestContext,
                requests: readonly IntegrationTriggerResourceRequest[],
              ) {
                sqliteResourceLoads += 1
                expect(authority).toBe(pair.authority)
                expect(requests).toEqual([integrationTriggerRequest])
                return [integrationTriggerSnapshot]
              },
            } as never
          },
        }),
      )
      expect(sqliteResourceLoads).toBe(1)
    } finally {
      sqlite.$client.close()
    }

    const postgresql = fixture([
      {},
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      { count: 1 },
      {},
      {
        values: [
          [
            scheduledRecord.id,
            scheduledRecord.name,
            scheduledRecord.ownerUserId,
            scheduledRecord.launchKind,
            scheduledRecord.launchPayload,
            scheduledRecord.scheduleSpec,
            scheduledRecord.enabled,
            scheduledRecord.nextRunAt,
            null,
            null,
            null,
            null,
            scheduledRecord.consecutiveFailures,
            0,
            scheduledRecord.createdAt,
            scheduledRecord.updatedAt,
          ],
        ],
      },
      { values: [[1]] },
    ])
    let postgresqlResourceLoads = 0
    let resourceTransaction: unknown
    await assertScheduledCreateBehavior(
      createPostgresqlScheduledTaskPersistence(postgresql.db, {
        async loadAuthorized(transaction, pair, requests) {
          resourceTransaction = transaction
          postgresqlResourceLoads += 1
          expect(pair.authority).toBeDefined()
          expect(requests).toEqual([integrationTriggerRequest])
          return [integrationTriggerSnapshot]
        },
      }),
    )
    expect(resourceTransaction).toBeDefined()
    expect(postgresqlResourceLoads).toBe(1)
    expect(postgresql.executions[0]?.sql.trim().toLowerCase()).toBe('begin')
    expect(postgresql.executions[3]?.sql.trim().toLowerCase()).toBe('commit')
    expect(postgresql.releases).toBe(1)
  })

  test('PostgreSQL launch reservation serializes on the MR stream before checking open state', async () => {
    const fake = fixture([
      {},
      {},
      { values: [['open', 4, null]] },
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      { count: 1 },
      {},
    ])
    const persistence = createPostgresqlMrLaunchGuardPersistence(fake.db)

    await expect(
      persistence.reserve({
        guardId: 'guard-1',
        ownerKey: 'owner-1',
        endpointId: 'endpoint-1',
        streamKey: 'mr-stream-1',
        binding: 'binding-1',
        launchRevision: 4,
        deliveryId: 'delivery-1',
        fireId: 'fire-1',
        triggerId: 'trigger-1',
        triggerName: 'Fixture trigger',
        createdAt: 100,
      }),
    ).resolves.toBeUndefined()

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    const lockIndex = statements.findIndex((statement) =>
      statement.includes('pg_advisory_xact_lock'),
    )
    const streamReadIndex = statements.findIndex((statement) =>
      statement.includes('from "agent_workflow"."webhook_mr_stream_states"'),
    )
    const guardInsertIndex = statements.findIndex((statement) =>
      statement.includes('insert into "agent_workflow"."webhook_mr_launch_guards"'),
    )
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(streamReadIndex).toBeGreaterThan(lockIndex)
    expect(guardInsertIndex).toBeGreaterThan(streamReadIndex)
    expect(fake.releases).toBe(1)
  })

  test('PostgreSQL verified ingress returns the existing fact and revives its pending effect', async () => {
    const fake = fixture([
      {},
      { values: [['delivery-1', 2]] },
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      { count: 1 },
      { values: [['effect-1', 'pending']] },
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      { count: 1 },
      {},
    ])
    const persistence = createPostgresqlVerifiedWebhookDeliveryPersistence(fake.db)

    await expect(
      persistence.accept({
        endpointId: 'endpoint-1',
        event: mrEvent(),
        rawBodyBytes: new TextEncoder().encode('{"fixture":true}'),
        rawBodyText: '{"fixture":true}',
        eventHeader: 'Merge Request Hook',
        objectKind: 'merge_request',
      }),
    ).resolves.toEqual({
      kind: 'duplicate',
      deliveryId: 'delivery-1',
      attemptCount: 3,
      effectId: 'effect-1',
    })

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    expect(statements[0]?.trim()).toBe('begin')
    expect(statements.at(-1)?.trim()).toBe('commit')
    expect(
      statements.some((statement) =>
        statement.includes('update "agent_workflow"."webhook_deliveries"'),
      ),
    ).toBe(true)
    expect(
      statements.some((statement) =>
        statement.includes('update "agent_workflow"."webhook_mr_control_effects"'),
      ),
    ).toBe(true)
    expect(fake.releases).toBe(1)
  })

  test('terminal ingress and launch reservation share one transaction lock key', () => {
    const reserveSource = createPostgresqlMrLaunchGuardPersistence.toString()
    const ingressSource = createPostgresqlVerifiedWebhookDeliveryPersistence.toString()
    expect(reserveSource).toContain('pg_advisory_xact_lock')
    expect(ingressSource).toContain('pg_advisory_xact_lock')
    expect(reserveSource).toContain('input.endpointId}:${input.streamKey')
    expect(ingressSource).toContain('input.endpointId}:${identity.streamKey')
  })

  test('PostgreSQL webhook ingress normalizes a live-event uniqueness collision into dedupe', async () => {
    const collision = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    })
    const fake = fixture([
      {},
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      collision,
      {},
      {},
      { objects: [{ generation_id: 'dbg_integration_pg' }] },
      { values: [['delivery-existing', 2]] },
      {},
    ])
    const persistence = createPostgresqlWebhookDeliveryPersistence(fake.db)

    const receipt = await persistence.insert({
      endpointId: 'endpoint-1',
      eventUuid: 'event-1',
      eventType: 'push',
      status: 'received',
      bodyJson: '{"fixture":true}',
    })
    expect(receipt).toEqual({
      kind: 'duplicate',
      deliveryId: 'delivery-existing',
      attemptCount: 2,
    })

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    expect(
      statements.some((statement) =>
        statement.includes('insert into "agent_workflow"."webhook_deliveries"'),
      ),
    ).toBe(true)
    const dedupeUpdate = statements.find((statement) =>
      statement.includes('update "agent_workflow"."webhook_deliveries"'),
    )
    expect(dedupeUpdate).toContain('"attempt_count" + 1')
    expect(dedupeUpdate).toContain('not in')
  })

  test('PostgreSQL integration trigger binds Resource Catalog and Digital Employee reads to one transaction', async () => {
    const descriptorJson = JSON.stringify({
      workIntakeAuthoring: {
        acceptedKinds: ['body'],
        targetFields: [{ fieldRef: 'issue', required: true }],
      },
    })
    const fake = fixture([
      {},
      {
        values: [['employee-1', 'owner-1', 'private', null, 3, 'developer', 2]],
      },
      {
        values: [['employee-1', 'owner-1', 'private', null, 3, 'developer', 2]],
      },
      { values: [['{"schemaVersion":1}']] },
      { values: [['published', descriptorJson]] },
      {},
    ])
    let resourceCatalogTransaction: unknown
    const resources = createPostgresqlIntegrationTriggerResources(fake.db, {
      inTransaction(transaction, pair, digitalEmployees) {
        resourceCatalogTransaction = transaction
        return {
          async loadAuthorized(authority, requests) {
            expect(authority).toBe(pair.authority)
            expect(requests).toEqual([
              { kind: 'webhook-digital-employee', employeeDefinitionId: 'employee-1' },
            ])
            const identity = await digitalEmployees.loadIdentity('employee-1')
            expect(identity).toMatchObject({
              id: 'employee-1',
              ownerUserId: 'owner-1',
              currentRevision: 3,
            })
            const snapshot = await digitalEmployees.loadCurrentSnapshot('employee-1')
            expect(snapshot).toEqual({
              kind: 'ready',
              employeeDefinitionId: 'employee-1',
              currentRevision: 3,
              typeId: 'developer',
              typeRevision: 2,
              intake: {
                acceptedKinds: ['body'],
                targetFields: [{ fieldRef: 'issue', required: true }],
              },
            })
            return [Object.freeze({ kind: 'fixture' })] as never
          },
        }
      },
    })
    const pair = { authority: Object.freeze({}), actor: Object.freeze({}) } as never

    const loaded = await resources.loadAuthorized(pair, [
      { kind: 'webhook-digital-employee', employeeDefinitionId: 'employee-1' },
    ])
    expect(loaded as unknown).toEqual([{ kind: 'fixture' }])

    expect(resourceCatalogTransaction).toBeDefined()
    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    const identityIndex = statements.findIndex((statement) =>
      statement.includes('from "agent_workflow"."employee_definitions"'),
    )
    const revisionIndex = statements.findIndex((statement) =>
      statement.includes('from "agent_workflow"."employee_definition_revisions"'),
    )
    const typePackageIndex = statements.findIndex((statement) =>
      statement.includes('from "agent_workflow"."employee_type_packages"'),
    )
    expect(identityIndex).toBeGreaterThanOrEqual(0)
    expect(revisionIndex).toBeGreaterThan(identityIndex)
    expect(typePackageIndex).toBeGreaterThan(revisionIndex)
    expect(statements[0]?.trim()).toBe('begin')
    expect(statements.at(-1)?.trim()).toBe('commit')
    expect(fake.releases).toBe(1)
  })

  test('PostgreSQL terminal-workspace policy reads only provider-neutral attribution', async () => {
    const fake = fixture([{ values: [['trigger-1', 'subscription-1']] }])
    const policy = createWebhookTerminalWorkspacePrunePolicy({
      attribution: createPostgresqlWebhookTerminalWorkspaceAttributionQueries(fake.db),
      enabled: () => true,
    })

    await expect(
      policy(
        {
          taskId: 'task-1',
          spaceKind: 'remote',
          workspacePruningAt: null,
          workspacePruneCause: null,
          workspacePrunedAt: null,
        },
        'done',
      ),
    ).resolves.toEqual({ prune: true, cause: 'webhook-terminal' })

    expect(fake.executions).toHaveLength(1)
    expect(fake.executions[0]?.sql.toLowerCase()).toContain('from "agent_workflow"."tasks"')
    expect(fake.executions[0]?.sql.toLowerCase()).not.toContain('employee_')
  })
})
