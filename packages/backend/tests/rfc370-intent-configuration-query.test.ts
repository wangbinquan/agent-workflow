// RFC-370: an asynchronous configuration adapter must settle before an Intent
// route writes a session or reserves a turn. Real persistence checks that a
// failed read leaves no operation behind and each request sees the current budget.
import { expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { intentSessions, intentTurns } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import {
  mountIntentSessionRoutes,
  type IntentSessionRouteDependencies,
} from '@/modules/intent/inbound/intentSessionRoutes'
import { createUser } from '@/services/users'
import { errorHandler } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createIntentSessionForTest,
  intentDumpAuxiliaryForTest,
  intentGraphValidationForTest,
  intentPersistenceForTest,
  intentResourceCatalogBinding,
  intentTurnRuntimeResolverForTest,
} from './helpers/intentResourceCatalogBinding'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

describeEachProvider('RFC-370 Intent configuration query', (harness) => {
  async function fixture(configuration: IntentSessionRouteDependencies['configuration']) {
    const db = harness.db
    const user = await createUser(db, {
      username: 'intent-configuration-user',
      displayName: 'Intent configuration user',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const actor = buildActor({ user, source: 'session' })
    const identityAccess = createIdentityAccessRuntime({ db })
    const http = new Hono()
    const injectActor: MiddlewareHandler = async (context, next) => {
      context.set('actor', actor)
      await next()
    }
    http.use('*', injectActor)
    http.onError(errorHandler)
    mountIntentSessionRoutes(http, {
      configuration,
      identityAccess,
      directAuthority: identityAccess.directAuthority,
      intentPersistence: intentPersistenceForTest(db),
      intentApply: {
        async apply() {
          throw new Error('fixture must not commit resources')
        },
      },
      intentTurnRuntime: {
        runtimeResolver: intentTurnRuntimeResolverForTest(db),
        dumpAuxiliary: intentDumpAuxiliaryForTest(db),
        graphValidation: intentGraphValidationForTest(db),
      },
      resourceCatalogFor: (currentActor) => intentResourceCatalogBinding(db, currentActor),
      events: {
        publish() {
          throw new Error('fixture must not dispatch a turn')
        },
      },
    })
    return { http, actor }
  }

  const post = (http: Hono, path: string, body: unknown) =>
    Promise.resolve(
      http.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  test('waits for a failed configuration read without creating a session or reserved turn', async () => {
    const entered = barrier()
    const release = barrier()
    let reads = 0
    const { http } = await fixture({
      async read(): Promise<Config> {
        reads += 1
        entered.release()
        await release.pending
        throw new Error('fixture-configuration-unavailable')
      },
    })
    const pending = post(http, '/api/intent-sessions', { message: 'Create an agent' })
    try {
      await Promise.race([
        entered.pending,
        pending.then(() => {
          throw new Error('request completed before configuration was read')
        }),
      ])
      expect(await harness.db.select().from(intentSessions)).toEqual([])
      expect(await harness.db.select().from(intentTurns)).toEqual([])
    } finally {
      release.release()
    }
    expect((await pending).status).toBe(500)
    expect(reads).toBe(1)
    expect(await harness.db.select().from(intentSessions)).toEqual([])
    expect(await harness.db.select().from(intentTurns)).toEqual([])
    // Payload validation retains its original precedence over configuration IO.
    const invalid = await post(http, '/api/intent-sessions', {})
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ code: 'intent-invalid' })
    expect(reads).toBe(1)
  })

  test('rereads the asynchronous generation budget for each message before reserving a turn', async () => {
    let limit = 1
    let reads = 0
    const { http, actor } = await fixture({
      async read() {
        reads += 1
        return { ...structuredClone(DEFAULT_CONFIG), intentBuilderMaxGenerateRounds: limit }
      },
    })
    const { session } = await createIntentSessionForTest(harness.db, actor, { message: 'Existing' })
    await harness.db
      .update(intentSessions)
      .set({ budgetJson: JSON.stringify({ generateRounds: 2, questionRounds: 0 }) })
      .where(eq(intentSessions.id, session.id))
    const before = await harness.db.select().from(intentTurns)
    for (const current of [1, 2]) {
      limit = current
      const response = await post(http, `/api/intent-sessions/${session.id}/messages`, {
        message: 'Continue',
      })
      expect(response.status).toBe(409)
      expect(await response.text()).toContain(`generation budget (${current})`)
      expect(await harness.db.select().from(intentTurns)).toEqual(before)
    }
    expect(reads).toBe(2)
  })
})
