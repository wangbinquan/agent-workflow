// RFC-349 regression — Intent context mutations must consume Resource
// Catalog's transaction-bound authorization participant. Preflight catalog
// summaries are useful UX, but they cannot authorize a later write.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeIntentPersistence } from '@/modules/intent/composition/persistence'
import type {
  IntentContextResourceAuthorization,
  IntentSessionRecord,
  IntentTurnRecord,
} from '@/modules/intent/application/ports/intentPersistence'
import { intentContextResourceAuthorizationSessionBrand } from '@/modules/resource-catalog/domain/participantBrands'
import type {
  IntentContextResourceAuthorizationSession,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'

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

function session(
  load: IntentContextResourceAuthorizationSession['loadVisible'],
): IntentContextResourceAuthorizationSession {
  return Object.freeze({
    [intentContextResourceAuthorizationSessionBrand]:
      'intent-context-resource-authorization-session' as const,
    loadVisible: load,
  })
}

describe('RFC-349 Intent transaction-bound context authorization', () => {
  // RFC-359 W7：SQLite 侧的 `dbTxSync` 已换成中立事务原语，断言的东西没变——
  // 授权仍必须发生在**驱动本程序的那一笔事务**里，失败要把 Intent 的插入一起回滚。
  test('the runner validates the resource inside the same transaction before inserting', async () => {
    const db = seedOwner()
    const current = authorization()
    let factoryCalls = 0
    let authorizationCalls = 0
    const persistence = composeIntentPersistence({
      db,
      contextAuthorization: {
        inTransaction(_transaction, pair) {
          factoryCalls += 1
          expect(pair).toBe(current.currentAuthority)
          return session(async (authority, reference) => {
            authorizationCalls += 1
            expect(authority).toBe(current.currentAuthority.authority)
            return {
              resourceType: reference.resourceType,
              resourceId: reference.resourceId,
              name: 'Visible agent',
            }
          })
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

  test('an invisible resource is rejected and the Intent insert rolls back', async () => {
    const db = seedOwner()
    const current = authorization()
    const persistence = composeIntentPersistence({
      db,
      contextAuthorization: {
        inTransaction() {
          return session(async () => null)
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
    // RFC-359 W7：两份 runner 合成一份中立实现，两个 provider 共用同一条授权路径。
    const runner = readFileSync(
      resolve(INTENT_ROOT, 'infrastructure/intentSqlProgramRunner.ts'),
      'utf8',
    )
    const applicationSession = readFileSync(resolve(INTENT_ROOT, 'application/session.ts'), 'utf8')

    expect(persistence).toContain('createSessionWithAuthorizedResources')
    expect(persistence).toContain('updateManifestWithAuthorizedResources')
    expect(persistence).toContain('assertAuthorizedResources(input.authorization, input.resources)')
    expect(persistence).toContain(
      'assertAuthorizedResources(input.visibility, authorizedResources)',
    )
    expect(persistence).toContain('assertAuthorizedResources(input.visibility, delta.additions)')
    expect(applicationSession).toContain('persistence.commitMountSuggestionDecision({')
    expect(applicationSession).toContain('resources: authorizedResources')
    expect(runner).toContain('await authorization.loadVisible(')
    // 只看代码，不看注释：头注释要讲清「合掉的是哪两份、为什么」，必然出现被淘汰的那些名字。
    const runnerCode = runner
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(runnerCode).not.toMatch(/as unknown|DbClient|PostgresqlDatabaseClient|dbTxSync/)
    for (const retired of [
      'infrastructure/sqliteIntentSqlProgramRunner.ts',
      'infrastructure/postgresqlIntentSqlProgramRunner.ts',
      'infrastructure/sqliteIntentPersistence.ts',
      'infrastructure/postgresqlIntentPersistence.ts',
    ]) {
      expect(() => readFileSync(resolve(INTENT_ROOT, retired), 'utf8'), retired).toThrow()
    }
  })
})
