// RFC-349 regression — Intent context mutations must consume Resource
// Catalog's transaction-bound authorization participant. Preflight catalog
// summaries are useful UX, but they cannot authorize a later write.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeSqliteIntentPersistence } from '@/modules/intent/composition/persistence'
import type {
  IntentContextResourceAuthorization,
  IntentSessionRecord,
  IntentTurnRecord,
} from '@/modules/intent/public/operations'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const INTENT_ROOT = resolve(import.meta.dir, '../src/modules/intent')

const SESSION: IntentSessionRecord = {
  id: 'intent-context-authorization-session',
  ownerUserId: 'intent-context-owner',
  title: 'Authorized context',
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
  id: 'intent-context-authorization-turn',
  sessionId: SESSION.id,
  seq: 1,
  role: 'user',
  kind: 'message',
  contentJson: '{"message":"authorize the initial mount"}',
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

function authorization(): IntentContextResourceAuthorization {
  return Object.freeze({
    currentAuthority: Object.freeze({
      authority: Object.freeze({}) as ResourceRequestContext,
      actor: Object.freeze({}) as DirectAuthenticatedAuthority,
    }),
    async visible() {
      return true
    },
  })
}

function seedOwner() {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(users)
    .values({
      id: SESSION.ownerUserId,
      username: SESSION.ownerUserId,
      displayName: 'Intent Context Owner',
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  return db
}

describe('RFC-349 Intent transaction-bound context authorization', () => {
  test('SQLite validates the resource inside the same dbTxSync before inserting', async () => {
    const db = seedOwner()
    const current = authorization()
    let factoryCalls = 0
    let authorizationCalls = 0
    const persistence = composeSqliteIntentPersistence({
      db,
      contextAuthorization: {
        inTransaction(_transaction, pair) {
          factoryCalls += 1
          expect(pair).toBe(current.currentAuthority)
          return {
            loadVisibleSync(authority, reference) {
              authorizationCalls += 1
              expect(authority).toBe(current.currentAuthority.authority)
              return {
                resourceType: reference.resourceType,
                resourceId: reference.resourceId,
                name: 'Visible agent',
              }
            },
          }
        },
      },
    })

    await persistence.createSessionWithAuthorizedResources({
      session: SESSION,
      userTurn: USER_TURN,
      authorization: current,
      resources: [{ resourceType: 'agent', resourceId: 'agent-visible' }],
    })

    expect(factoryCalls).toBe(1)
    expect(authorizationCalls).toBe(1)
    await expect(persistence.findSession(SESSION.id)).resolves.toEqual(SESSION)
  })

  test('SQLite rejects an invisible resource and rolls the Intent insert back', async () => {
    const db = seedOwner()
    const current = authorization()
    const persistence = composeSqliteIntentPersistence({
      db,
      contextAuthorization: {
        inTransaction() {
          return { loadVisibleSync: () => null }
        },
      },
    })

    await expect(
      persistence.createSessionWithAuthorizedResources({
        session: SESSION,
        userTurn: USER_TURN,
        authorization: current,
        resources: [{ resourceType: 'agent', resourceId: 'agent-hidden' }],
      }),
    ).rejects.toMatchObject({ code: 'resource-not-found' })
    await expect(persistence.findSession(SESSION.id)).resolves.toBeNull()
  })

  test('all context mutation paths revalidate through the transaction instruction', () => {
    const persistence = readFileSync(
      resolve(INTENT_ROOT, 'infrastructure/intentSqlPersistence.ts'),
      'utf8',
    )
    const sqlite = readFileSync(
      resolve(INTENT_ROOT, 'infrastructure/sqliteIntentSqlProgramRunner.ts'),
      'utf8',
    )
    const postgresql = readFileSync(
      resolve(INTENT_ROOT, 'infrastructure/postgresqlIntentSqlProgramRunner.ts'),
      'utf8',
    )
    const session = readFileSync(
      resolve(import.meta.dir, '../src/services/intent/session.ts'),
      'utf8',
    )

    expect(persistence).toContain('createSessionWithAuthorizedResources')
    expect(persistence).toContain('updateManifestWithAuthorizedResources')
    expect(persistence).toContain('assertAuthorizedResources(input.authorization, input.resources)')
    expect(persistence).toContain(
      'assertAuthorizedResources(input.visibility, authorizedResources)',
    )
    expect(persistence).toContain('assertAuthorizedResources(input.visibility, delta.additions)')
    expect(session).toContain('persistence.commitMountSuggestionDecision({')
    expect(session).toContain('resources: authorizedResources')
    expect(sqlite).toContain('authorization.loadVisibleSync(')
    expect(postgresql).toContain('await authorization.loadVisible(')
    expect(postgresql).not.toMatch(/as unknown|DbClient/)
  })
})
