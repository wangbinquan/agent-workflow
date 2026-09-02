// RFC-349 regression — provider-neutral Intent persistence must render INSERT
// column lists and UPDATE assignments as unqualified identifiers. Drizzle
// table-column fragments are valid in expressions, but produce
// `"table"."column"` in INSERT column lists and SET targets, which SQLite
// rejects and PostgreSQL does not accept either.

import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { users } from '@/db/schema'
import type {
  IntentSessionRecord,
  IntentTurnRecord,
} from '@/modules/intent/application/ports/intentPersistence'
import { createPostgresqlIntentPersistence } from '@/modules/intent/infrastructure/postgresqlIntentPersistence'
import { createSqliteIntentPersistence } from '@/modules/intent/infrastructure/sqliteIntentPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

const SESSION: IntentSessionRecord = {
  id: 'intent-session-sql-rendering',
  ownerUserId: 'intent-sql-owner',
  title: 'Provider-correct SQL rendering',
  status: 'active',
  contextRevision: 0,
  contextManifestJson: '[]',
  handleWatermarkJson: '{}',
  currentDraftId: null,
  inFlightTurnId: null,
  turnSeq: 1,
  commitSeq: 0,
  budgetJson: '{"generateRounds":0,"questionRounds":0}',
  createdAt: 1,
  updatedAt: 1,
}

const USER_TURN: IntentTurnRecord = {
  id: 'intent-turn-sql-rendering',
  sessionId: SESSION.id,
  seq: 1,
  role: 'user',
  kind: 'message',
  contentJson: '{"message":"render identifiers"}',
  contextRevision: 0,
  envelopeNonce: null,
  runMetaJson: null,
  clientMutationId: null,
  captureState: null,
  captureLastEventSeq: 0,
  captureEventBytes: 0,
  captureRootSessionId: null,
  captureIncompleteReason: null,
  scratchRetained: false,
  createdAt: 1,
}

function rows(
  input: {
    readonly objects?: readonly Record<string, unknown>[]
    readonly values?: readonly (readonly unknown[])[]
    readonly count?: number
  } = {},
): SqlRows {
  const objects = [...(input.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = input.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return input.values ?? []
    },
  })
}

function postgresqlFixture() {
  const statements: string[] = []
  let releases = 0
  const execute = (statement: string): SqlRows => {
    statements.push(statement)
    if (statement.includes('database_generations')) {
      return rows({ objects: [{ generation_id: 'dbg_intent_sql' }], count: 1 })
    }
    if (statement.toLowerCase().includes('select') && statement.includes('"intent_sessions"')) {
      return rows({
        objects: [{ ...SESSION }],
        values: [
          [
            SESSION.id,
            SESSION.ownerUserId,
            SESSION.title,
            SESSION.status,
            SESSION.contextRevision,
            SESSION.contextManifestJson,
            SESSION.handleWatermarkJson,
            SESSION.currentDraftId,
            SESSION.inFlightTurnId,
            SESSION.turnSeq,
            SESSION.commitSeq,
            SESSION.budgetJson,
            SESSION.createdAt,
            SESSION.updatedAt,
          ],
        ],
        count: 1,
      })
    }
    if (/^\s*insert\b/i.test(statement)) return rows({ objects: [{}], count: 1 })
    return rows()
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
    generationId: 'dbg_intent_sql',
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
    statements,
    get releases() {
      return releases
    },
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Intent SQL persistence identifier rendering', () => {
  test('SQLite createSession writes and reads the shared persistence records', async () => {
    selectDatabaseSchemaProvider('sqlite')
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(users).values({
      id: SESSION.ownerUserId,
      username: 'intent-sql-owner',
      displayName: 'Intent SQL Owner',
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const persistence = createSqliteIntentPersistence(db)

    await persistence.createSession({ session: SESSION, userTurn: USER_TURN })

    await expect(persistence.findSession(SESSION.id)).resolves.toEqual(SESSION)
    await expect(persistence.listTurns(SESSION.id)).resolves.toEqual([USER_TURN])
  })

  test('PostgreSQL createSession keeps table qualification out of INSERT columns', async () => {
    const fixture = postgresqlFixture()
    const persistence = createPostgresqlIntentPersistence(fixture.db)

    await persistence.createSession({ session: SESSION, userTurn: USER_TURN })

    const inserts = fixture.statements.filter((statement) => /^\s*insert\b/i.test(statement))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]).toContain('INSERT INTO "agent_workflow"."intent_sessions" (\n    "id"')
    expect(inserts[1]).toContain('INSERT INTO "agent_workflow"."intent_turns" (\n    "id"')
    for (const statement of inserts) {
      expect(statement).not.toMatch(/"intent_(?:sessions|turns)"\."[a-z_]+"/)
    }
    expect(fixture.releases).toBe(1)
  })

  test('PostgreSQL update assignments keep table qualification out of SET targets', async () => {
    const fixture = postgresqlFixture()
    const persistence = createPostgresqlIntentPersistence(fixture.db)

    const result = await persistence.setStatus({
      ownerUserId: SESSION.ownerUserId,
      sessionId: SESSION.id,
      status: 'archived',
      updatedAt: 2,
    })
    expect(result).toBe('updated')

    const updates = fixture.statements.filter(
      (statement) => /^\s*update\b/i.test(statement) && statement.includes('"intent_sessions"'),
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain('SET "status" =')
    expect(updates[0]).toContain('"updated_at" =')
    expect(updates[0]).not.toMatch(/SET\s+"intent_sessions"\./)
    expect(fixture.releases).toBe(1)
  })
})
