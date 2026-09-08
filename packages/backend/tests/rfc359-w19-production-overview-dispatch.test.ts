// RFC-359 W19: the performance/test overview must select the PG daemon's owner
// composition. The real client's provider is a Proxy getter, not an own member.
// This protocol probe throws before every SQL execution and returns no rows;
// real database results and HTTP timing remain in the existing hosted suites.

import { describe, expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { createTaskOverviewQuery } from '@/modules/task-execution/composition/taskOverview'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { createProductionOverviewQuery, runProductionOverview } from './helpers/productionOverview'

interface ObservedStatement {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

function createDispatchProbe() {
  const statements: ObservedStatement[] = []
  const stop = new Error('overview-dispatch-stopped-before-sql')
  let closeCount = 0
  const pool: PostgresqlPool = {
    unsafe(sql, parameters = []) {
      statements.push({ sql, parameters })
      throw stop
    },
    async reserve() {
      throw new Error('overview-dispatch-unexpected-reservation')
    },
    async close() {
      closeCount += 1
    },
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_OVERVIEW_DISPATCH_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
    generationId: 'dbg_rfc359_overview_dispatch',
    env: {
      RFC359_OVERVIEW_DISPATCH_URL: 'postgresql://fixture:fixture@localhost/fixture',
    },
    poolFactory: () => pool,
  })
  return {
    db: createPostgresqlDatabaseClient(runtime),
    runtime,
    stop,
    statements,
    closeCount: () => closeCount,
  }
}

function taskCountStatements(statements: readonly ObservedStatement[]): ObservedStatement[] {
  return statements.filter((statement) =>
    statement.sql.startsWith('select count(*) from "agent_workflow"."tasks" where '),
  )
}

async function expectStoppedBeforeSql(response: Promise<unknown>, stop: Error): Promise<void> {
  let observed: unknown
  try {
    await response
  } catch (error) {
    observed = error
  }
  // Drizzle query builders wrap the marker; raw read ports preserve it directly.
  while (observed instanceof Error && observed.cause !== undefined) observed = observed.cause
  expect(observed).toBe(stop)
}

describe('RFC-359 W19 overview provider dispatch', () => {
  test('the real PG client exposes its provider getter before any query', async () => {
    const probe = createDispatchProbe()
    try {
      expect(probe.db.$provider).toBe('postgresql')
      expect(Reflect.get(probe.db, '$provider')).toBe('postgresql')
      expect('$provider' in probe.db).toBe(false)
      expect(Reflect.get(probe.db, 'resultKind')).toBe('async')
      expect(probe.statements).toEqual([])
    } finally {
      await probe.runtime.close()
    }
    expect(probe.closeCount()).toBe(1)
  })

  for (const entryPoint of ['constructed', 'one-shot'] as const) {
    test(`${entryPoint} overview sends the actual PG owner count statements`, async () => {
      const probe = createDispatchProbe()
      try {
        // Existing request construction is opaque to this dispatch-only probe.
        const actor = buildActor({
          user: {
            id: 'rfc359-overview-dispatch-user',
            username: 'overview-dispatch',
            displayName: 'Overview dispatch',
            role: 'admin',
            status: 'active',
          },
          source: 'session',
        })
        const identityAccess = composeIdentityAccess(probe.db)
        const context = identityAccess.contexts.fromAuthenticatedPrincipal(
          { userId: actor.user.id, source: actor.source },
          'http',
        )
        const query = createProductionOverviewQuery(probe.db, identityAccess)
        expect(probe.statements).toEqual([])

        const response =
          entryPoint === 'constructed'
            ? query.execute({ actor, authority: context.authority })
            : runProductionOverview(probe.db, actor)
        await expectStoppedBeforeSql(response, probe.stop)
        const observed = taskCountStatements(probe.statements)
        expect(observed).toHaveLength(4)

        // Reuse this observation's exact time boundary without changing any
        // clock or query. Only the true owner compiles the reference statements.
        const since = observed
          .flatMap((statement) => statement.parameters)
          .find((parameter): parameter is number => typeof parameter === 'number')
        if (since === undefined) throw new Error('overview-dispatch-missing-time-boundary')
        probe.statements.length = 0
        await expectStoppedBeforeSql(
          createTaskOverviewQuery(probe.db).load({ actor, since }),
          probe.stop,
        )
        const owner = taskCountStatements(probe.statements)
        expect(owner).toHaveLength(4)
        expect(observed).toEqual(owner)
      } finally {
        await probe.runtime.close()
      }
      expect(probe.closeCount()).toBe(1)
    })
  }
})
