import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import { createHttpRequestApp } from '@/server'
import { users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import {
  admitDurableWorkOwner,
  composeHttpAuthenticationMiddleware,
  composeLocalHttpAuthentication,
} from '@/modules/identity-access/composition/authentication'
import type { HttpAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { UnauthorizedError, errorHandler } from '@/util/errors'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProvider } from './helpers/eachProvider'

// RFC-370: the shared HTTP middleware must consume its chosen adapter. Keep
// the local credential flow's coalescing and public-login behavior while an
// independent adapter can admit the same registered Identity Access identity.
function app(authentication: HttpAuthenticationParticipant) {
  const http = new Hono()
  http.use('/api/*', composeHttpAuthenticationMiddleware(authentication))
  http.get('/api/whoami', (context) => context.json({ id: actorOf(context).user.id }))
  http.get('/api/auth/login', (context) => context.json({ reached: true }))
  http.onError(errorHandler)
  return http
}

describeEachProvider('RFC-370 HTTP authentication adapter', (harness) => {
  async function fixture() {
    await harness.db.insert(users).values({
      id: 'http-adapter-user',
      username: 'http-adapter-user',
      displayName: 'HTTP adapter user',
      role: 'user',
      status: 'active',
      passwordHash: null,
      forcePasswordChange: false,
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    })
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    const auth = createAuthRuntimeFor({ db: harness.db })
    const { token } = await createSession({
      db: harness.db,
      userId: 'http-adapter-user',
      now: 1000,
    })
    return { identityAccess, auth, token }
  }

  test('uses an injected asynchronous adapter without requiring a local bearer credential', async () => {
    const { identityAccess, auth } = await fixture()
    const identity = await admitDurableWorkOwner(identityAccess, 'http-adapter-user')
    if (identity === null) throw new Error('fixture-identity-missing')
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: { method: string; path: string; proof: string | null }[] = []
    const authentication: HttpAuthenticationParticipant = {
      async authenticate(request) {
        requests.push({
          method: request.method,
          path: request.path,
          proof: request.header('X-Fixture-Identity'),
        })
        if (request.header('X-Fixture-Identity') !== 'fixture-user') throw new UnauthorizedError()
        await barrier
        return { kind: 'authenticated', identity }
      },
    }
    const http = createHttpRequestApp({
      authentication,
      core: {
        provider: harness.session.engine.provider,
        authRuntime: auth,
        identityAccess,
        tokenCallAudit: createTokenCallAudit(harness.db),
        sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
      },
      publicRoutes: { health() {}, wellKnown() {}, webhookIngress() {} },
      mountApi(routes) {
        routes.get('/api/auth/login', (context) => context.json({ reached: true }))
      },
    })
    let returned = false
    const pending = Promise.resolve(
      http.request('/api/whoami', { headers: { 'X-Fixture-Identity': 'fixture-user' } }),
    ).then((response) => {
      returned = true
      return response
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    release()
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { id: 'http-adapter-user' } })
    expect(requests).toEqual([{ method: 'GET', path: '/api/whoami', proof: 'fixture-user' }])
    // Public-path selection also belongs to the selected adapter.
    expect((await http.request('/api/auth/login')).status).toBe(401)
  })

  test('coalesces overlapping local reads but rereads the credential after settlement', async () => {
    const { auth, identityAccess, token } = await fixture()
    let lookups = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const countedAuth = {
      ...auth,
      async lookupActiveSession(...args: Parameters<typeof auth.lookupActiveSession>) {
        lookups += 1
        await barrier
        return await auth.lookupActiveSession(...args)
      },
    }
    const authentication = composeLocalHttpAuthentication({
      auth: countedAuth,
      identityAccess,
      daemonToken: 'fixture-daemon',
      now: () => 1000,
    })
    const request = { method: 'GET', path: '/api/whoami', header: () => `Bearer ${token}` }
    const first = authentication.authenticate(request)
    const overlapping = authentication.authenticate(request)
    release()
    const results = await Promise.all([first, overlapping])
    expect(lookups).toBe(1)
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({
      kind: 'authenticated',
      identity: { actor: { userId: 'http-adapter-user' } },
    })
    await authentication.authenticate(request)
    expect(lookups).toBe(2)
  })

  test('retains the standalone public login route through the selected local adapter', async () => {
    const { auth, identityAccess } = await fixture()
    const http = app(
      composeLocalHttpAuthentication({ auth, identityAccess, daemonToken: 'fixture-daemon' }),
    )
    expect((await http.request('/api/auth/login')).status).toBe(200)
    expect((await http.request('/api/whoami')).status).toBe(401)
  })
})
