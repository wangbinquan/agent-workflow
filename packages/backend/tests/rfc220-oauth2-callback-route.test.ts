// RFC-220 T3 — route-level OAuth-only login chain (design §12 S8).
//
// S5/S6 lock the helper functions; THIS file locks the route wiring — the
// gate round-2 P2 finding was precisely that every listed unit gate could
// stay green while the callback itself was broken. A local Bun.serve plays
// the IdP (token endpoint answers access-token-only, userinfo returns a
// platform-defined shape), the provider's manual endpoints point at it, and
// issuerUrl points at a closed port so discovery fails fast and the manual
// fallback carries the whole login.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { ne } from 'drizzle-orm'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { clearEndpointCaches } from '../src/auth/oidc/endpoints'
import { clearPendingFlows } from '../src/auth/oidc/flow'
import { userIdentities, users } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// Nothing listens here — discovery probes fail with an instant connection
// refusal, keeping the suite offline and fast.
const DEAD_ISSUER = 'http://127.0.0.1:1'

interface IdpState {
  userinfoBody: Record<string, unknown>
  /** Ran inside the userinfo request — lets a test mutate provider config
   * MID-CALLBACK (after the route read the provider, before the identity
   * write) to exercise the write-time subjectClaim recheck. */
  onUserinfo?: () => Promise<void>
}

const idpState: IdpState = { userinfoBody: {} }

const idp = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/oauth/token') {
      // pure OAuth 2.0: access token only, no id_token
      return Response.json({ access_token: 'at-1', token_type: 'bearer' })
    }
    if (url.pathname === '/api/user') {
      if (idpState.onUserinfo) await idpState.onUserinfo()
      if (req.headers.get('authorization') !== 'Bearer at-1') {
        return Response.json({ error: 'bad token' }, { status: 401 })
      }
      return Response.json(idpState.userinfoBody)
    }
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => idp.stop(true))

const IDP = `http://127.0.0.1:${idp.port}`

interface Harness {
  db: DbClient
  app: ReturnType<typeof createApp>
  providerId: string
}

async function buildHarness(overrides?: Record<string, unknown>): Promise<Harness> {
  clearEndpointCaches()
  clearPendingFlows()
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const app = createApp({
    token: 'daemon-token',
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  const svc = createOidcProvidersService({ db, secretBox })
  const provider = await svc.create({
    slug: 'pure',
    displayName: 'Pure OAuth IdP',
    issuerUrl: DEAD_ISSUER,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    scopes: 'read:user',
    provisioning: 'auto',
    allowedEmailDomains: [],
    iconUrl: null,
    enabled: true,
    authorizationEndpoint: `${IDP}/oauth/authorize`,
    tokenEndpoint: `${IDP}/oauth/token`,
    userinfoEndpoint: `${IDP}/api/user`,
    trustEmailVerified: true,
    usernameClaim: 'login sig',
    subjectClaim: 'id',
    ...overrides,
  })
  return { db, app, providerId: provider.id }
}

async function startLogin(h: Harness): Promise<{ state: string; authorizeUrl: string }> {
  const res = await h.app.request('/api/auth/oidc/pure/login/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { state: string; authorizeUrl: string }
}

describe('RFC-220 S8 — route-level OAuth-only chain', () => {
  beforeEach(() => {
    idpState.userinfoBody = {}
    delete idpState.onUserinfo
  })

  test('start without any usable endpoint → structured 503 with code AND message', async () => {
    const h = await buildHarness({
      authorizationEndpoint: null,
      tokenEndpoint: null,
      userinfoEndpoint: null,
    })
    const res = await h.app.request('/api/auth/oidc/pure/login/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('oidc-endpoints-unresolved')
    // message must be a string or the frontend decoder collapses the code
    expect(typeof body.message).toBe('string')
  })

  test('start with manual endpoints: authorizeUrl comes from the manual authorize', async () => {
    const h = await buildHarness()
    const { authorizeUrl, state } = await startLogin(h)
    expect(authorizeUrl.startsWith(`${IDP}/oauth/authorize?`)).toBe(true)
    expect(state.length).toBeGreaterThan(10)
    const url = new URL(authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('access-token-only callback: provisioning + identity + session + redirect', async () => {
    const h = await buildHarness()
    idpState.userinfoBody = {
      id: 42, // subjectClaim: 'id' — numeric platform id
      login: 'zhang',
      sig: '我爱写代码',
      email: 'zhang@corp.test',
      // note: NO email_verified field — trustEmailVerified covers it
    }
    const { state } = await startLogin(h)
    const res = await h.app.request(`/api/auth/oidc/pure/callback?code=abc&state=${state}`)
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toContain('#aw_session=')

    // identity persisted under the CONFIGURED subject namespace
    const identities = await h.db.select().from(userIdentities)
    expect(identities.length).toBe(1)
    expect(identities[0]!.subject).toBe('42')
    expect(identities[0]!.emailVerified).toBe(1) // trustEmailVerified applied
    expect(identities[0]!.preferredSnapshot).toBe('zhang 我爱写代码')

    // auto-provisioned user: composed presented name + derived username
    const userRows = await h.db.select().from(users).where(eq(users.id, identities[0]!.userId))
    expect(userRows[0]!.displayName).toBe('zhang 我爱写代码')
    expect(userRows[0]!.status).toBe('active')

    // second login with a changed IdP-side signature refreshes the name (D7)
    idpState.userinfoBody = { ...idpState.userinfoBody, sig: '换个签名' }
    const second = await startLogin(h)
    const res2 = await h.app.request(`/api/auth/oidc/pure/callback?code=def&state=${second.state}`)
    expect(res2.status).toBe(302)
    const refreshed = await h.db.select().from(users).where(eq(users.id, identities[0]!.userId))
    expect(refreshed[0]!.displayName).toBe('zhang 换个签名')
    // same account, no dup (createApp seeds a __system__ row — exclude it)
    const humans = await h.db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
    expect(humans.length).toBe(1)
  })

  test('mid-callback subjectClaim change → 400 friendly page + ZERO side effects', async () => {
    const h = await buildHarness()
    idpState.userinfoBody = { id: 42, login: 'zhang' }
    const { state } = await startLogin(h)
    // The userinfo handler runs after the route read the provider row and
    // before the identity write — exactly the TOCTOU window the write-time
    // recheck closes. No identities exist yet, so the PATCH-side lock allows
    // the change; only the write-time gate can catch this interleaving.
    idpState.onUserinfo = async () => {
      const svc = createOidcProvidersService({
        db: h.db,
        secretBox: createSecretBoxFromKey(randomBytes(32)),
      })
      await svc.patch(h.providerId, { subjectClaim: null })
    }
    const res = await h.app.request(`/api/auth/oidc/pure/callback?code=abc&state=${state}`)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('configuration changed')
    // zero side effects: no user beyond the seeded __system__, no identity
    const humans = await h.db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
    expect(humans.length).toBe(0)
    expect((await h.db.select().from(userIdentities)).length).toBe(0)
  })

  test('no userinfo configured (subjectClaim mode) → 400 userinfo-unavailable page', async () => {
    const h = await buildHarness({ userinfoEndpoint: null })
    const { state } = await startLogin(h)
    const res = await h.app.request(`/api/auth/oidc/pure/callback?code=abc&state=${state}`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('no userinfo endpoint is configured')
  })
})
