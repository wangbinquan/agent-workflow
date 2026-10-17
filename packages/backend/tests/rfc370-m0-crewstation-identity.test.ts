// RFC-370 M0 — CrewStation identity admission
// (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §3.6, §5.1).
// Locks: only a user identity token signed for this service is accepted; the
// platform subject maps to exactly one aw account created on first sight
// (least-privileged default role, configured administrators, never merged by
// email); a disabled account is refused; HTTP and WebSocket admit identically.
import { beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import { Hono } from 'hono'
import { DEFAULT_CONFIG, resolveTokenPermissions } from '@agent-workflow/shared'
import { mountMcpTransport } from '@/mcp/server'
import { errorHandler } from '@/util/errors'
import { composeHttpAuthenticationMiddleware } from '@/modules/identity-access/composition/authentication'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose'
import { externalIdentities, userPermissionGrants, users } from '@/db/schema'
import {
  composeCrewStationCredentialAdapters,
  composeCrewStationRecoveryRequester,
} from '@/modules/identity-access/composition/authentication'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import {
  createCrewStationIdentityTokenVerifier,
  crewStationServiceAudience,
} from '@/modules/identity-access/infrastructure/crewstation/crewStationIdentityToken'
import { externalIdentityUsername } from '@/modules/identity-access/infrastructure/externalIdentityProvisioning'
import { describeEachProvider } from './helpers/eachProvider'

const AUDIENCE = crewStationServiceAudience('agent-workflow', 'agent-workflow')
const SUBJECT = 'user:0193a7c0-0000-7000-8000-000000000001'
const ADMIN = 'user:0193a7c0-0000-7000-8000-000000000002'

let privateKey: CryptoKey
let keys: JWTVerifyGetKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const jwk = await exportJWK(pair.publicKey)
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] })
})

async function token(
  overrides: {
    readonly subject?: string
    readonly audience?: string
    readonly issuer?: string
    readonly kind?: string
    readonly expiresIn?: string
    readonly claims?: Record<string, unknown>
  } = {},
): Promise<string> {
  return await new SignJWT({ cs_kind: overrides.kind ?? 'user', ...overrides.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(overrides.subject ?? SUBJECT)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuer(overrides.issuer ?? 'crewstation')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(privateKey)
}

test('only a user identity token signed for this service is accepted', async () => {
  const verifier = createCrewStationIdentityTokenVerifier({
    jwksUrl: 'http://jwks.invalid/.well-known/jwks.json',
    audience: AUDIENCE,
    keys,
  })
  const claims = await verifier.verify(
    await token({ claims: { name: ' Ada ', email: 'ada@x.io' } }),
  )
  expect(claims).toMatchObject({ subject: SUBJECT, name: 'Ada', email: 'ada@x.io' })
  expect(claims!.expiresAt).toBeGreaterThan(Date.now())
  for (const bad of [
    await token({ audience: 'service:other/other' }),
    await token({ issuer: 'someone-else' }),
    await token({ kind: 'service' }),
    await token({ subject: 'service:agent-workflow/agent-workflow' }),
    await token({ expiresIn: '-1m' }),
    'not-a-jwt',
  ]) {
    expect(await verifier.verify(bad)).toBeNull()
  }
})

test('a platform subject maps to a stable valid username', () => {
  expect(externalIdentityUsername('crewstation', SUBJECT)).toBe(
    'cs-0193a7c0-0000-7000-8000-000000000001',
  )
  expect(externalIdentityUsername('other', 'user:Weird Name!')).toBe('ext-weird-name-')
})

describeEachProvider('RFC-370 M0 CrewStation credential adapters', (harness) => {
  function adapters() {
    return composeCrewStationCredentialAdapters({
      jwksUrl: 'http://jwks.invalid/.well-known/jwks.json',
      project: 'agent-workflow',
      service: 'agent-workflow',
      administratorSubjects: [ADMIN],
      keys,
    })({
      db: harness.db,
      auth: createAuthRuntimeFor({ db: harness.db }),
      daemonToken: 'unused',
      identityAccess: createIdentityAccessRuntime({ db: harness.db }),
    })
  }
  const request = (value: string | null) => ({
    method: 'GET',
    path: '/api/agents',
    header: (name: string) => (name === 'x-cs-identity-token' ? value : null),
  })

  test('automation requires both the platform identity and a same-account scoped PAT on every request', async () => {
    const http = adapters().http
    const signed = await token({ subject: ADMIN })
    const admitted = await http.authenticate(request(signed))
    if (admitted.kind !== 'authenticated') throw new Error('fixture identity missing')
    const auth = createAuthRuntimeFor({ db: harness.db })
    const own = await auth.createPat({
      userId: admitted.identity.actor.user.id,
      name: 'automation',
      purpose: 'general',
      scopes: ['agents:read'],
    })
    const automated = (identity: string | null, authorization: string) => ({
      ...request(identity),
      header: (name: string) =>
        name.toLowerCase() === 'authorization'
          ? authorization
          : name === 'x-cs-identity-token'
            ? identity
            : null,
    })
    const result = await http.authenticate(automated(signed, `Bearer ${own.token}`))
    if (result.kind !== 'authenticated') throw new Error('PAT not admitted')
    expect(result.identity.actor).toMatchObject({
      source: 'pat',
      purpose: 'general',
      patId: own.meta.id,
    })
    expect(result.identity.actor.permissions).toEqual(
      resolveTokenPermissions({
        accountPermissions: admitted.identity.actor.permissions,
        matrix: ['agents:read'],
      }),
    )
    expect(result.identity.actor.permissions.has('agents:create')).toBe(false)
    await expect(http.authenticate(automated(null, `Bearer ${own.token}`))).rejects.toMatchObject({
      status: 401,
    })
    await expect(
      http.authenticate(automated(await token(), `Bearer ${own.token}`)),
    ).rejects.toMatchObject({ status: 401 })
    for (const value of ['Bearer aw_sess_invalid', 'Basic invalid', '', 'Bearer aw_pat_invalid'])
      await expect(http.authenticate(automated(signed, value))).rejects.toMatchObject({
        status: 401,
      })
    await auth.revokePat(own.meta.id)
    await expect(http.authenticate(automated(signed, `Bearer ${own.token}`))).rejects.toMatchObject(
      { status: 401 },
    )
    // A revoked PAT is not cached and cannot silently broaden to browser authority.
    const browser = await http.authenticate(request(signed))
    if (browser.kind !== 'authenticated') throw new Error('browser identity missing')
    expect(browser.identity.actor.source).toBe('session')
  })

  test('hosted MCP keeps the PAT gate and scoped tools behind the signed platform user', async () => {
    const http = adapters().http
    const signed = await token({ subject: ADMIN })
    const admitted = await http.authenticate(request(signed))
    if (admitted.kind !== 'authenticated') throw new Error('fixture identity missing')
    const auth = createAuthRuntimeFor({ db: harness.db })
    const pat = await auth.createPat({
      userId: admitted.identity.actor.user.id,
      name: 'mcp',
      purpose: 'mcp_only',
      scopes: ['agents:read'],
    })
    const app = new Hono()
    app.use('/api/*', composeHttpAuthenticationMiddleware(http))
    mountMcpTransport(app, {
      tokenCallAudit: createTokenCallAudit(harness.db),
      configuration: { read: () => ({ ...DEFAULT_CONFIG, mcpSurfaceEnabled: true }) },
      operationInvokerFor: () => async () => {
        throw new Error('tools/list must not execute a tool')
      },
    })
    app.onError(errorHandler)
    const call = (headers: Record<string, string>, method = 'initialize') =>
      app.request('/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params:
            method === 'initialize'
              ? {
                  protocolVersion: '2025-06-18',
                  capabilities: {},
                  clientInfo: { name: 'hosted-test', version: '1' },
                }
              : {},
        }),
      })
    expect((await call({ 'x-cs-identity-token': signed })).status).toBe(401)
    expect((await call({ authorization: `Bearer ${pat.token}` })).status).toBe(401)
    const headers = { 'x-cs-identity-token': signed, authorization: `Bearer ${pat.token}` }
    const handshake = await call(headers)
    expect(handshake.status).toBe(200)
    expect(await handshake.text()).toContain('agent-workflow')
    const listing = await call(headers, 'tools/list')
    expect(listing.status).toBe(200)
    const body = await listing.text()
    expect(body).toContain('"name":"resource_read"')
    expect(body).not.toContain('"name":"launch_task"')
    await auth.revokePat(pat.meta.id)
    expect((await call(headers)).status).toBe(401)
  })

  test('first access creates one least-privileged account; later access reuses it', async () => {
    const http = adapters().http
    const signed = await token({ claims: { name: 'Ada', email: 'ada@example.com' } })
    const first = await http.authenticate(request(signed))
    expect(first.kind).toBe('authenticated')
    const again = await http.authenticate(request(await token()))
    expect(again.kind === 'authenticated' && first.kind === 'authenticated').toBe(true)
    if (first.kind !== 'authenticated' || again.kind !== 'authenticated') return
    expect(again.identity.actor.user.id).toBe(first.identity.actor.user.id)
    const account = (
      await harness.db.select().from(users).where(eq(users.id, first.identity.actor.user.id))
    )[0]!
    expect(account).toMatchObject({
      username: externalIdentityUsername('crewstation', SUBJECT),
      displayName: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
      status: 'active',
      passwordHash: null,
    })
    expect(await harness.db.select().from(externalIdentities)).toMatchObject([
      { issuer: 'crewstation', subject: SUBJECT, userId: account.id },
    ])
  })

  test('configured administrator subjects start as administrators', async () => {
    const admitted = await adapters().http.authenticate(request(await token({ subject: ADMIN })))
    expect(admitted.kind).toBe('authenticated')
    if (admitted.kind !== 'authenticated') return
    expect(admitted.identity.actor.user.role).toBe('admin')
    expect(
      await harness.db
        .select()
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, admitted.identity.actor.user.id)),
    ).toEqual([])
  })

  test('recovery resolves only an existing platform link and rechecks the current account', async () => {
    const requester = composeCrewStationRecoveryRequester({
      db: harness.db,
      identityAccess: createIdentityAccessRuntime({ db: harness.db }),
    })
    const id = SUBJECT.slice('user:'.length)
    const before = await harness.db.select({ id: users.id }).from(users)
    for (const unknown of [id, ADMIN.slice(5), SUBJECT, '__system__', '', 'invalid'])
      expect(await requester.resolve(unknown)).toBeNull()
    expect(await harness.db.select({ id: users.id }).from(users)).toEqual(before)
    expect(await harness.db.select().from(externalIdentities)).toEqual([])

    const admitted = await adapters().http.authenticate(request(await token()))
    if (admitted.kind !== 'authenticated') throw new Error('fixture identity missing')
    const accountId = admitted.identity.actor.user.id
    expect((await requester.resolve(id))?.actor.user).toMatchObject({
      id: accountId,
      role: 'guest',
    })
    await harness.db.update(users).set({ role: 'user' }).where(eq(users.id, accountId))
    expect((await requester.resolve(id))?.actor.user.role).toBe('user')
    await harness.db.update(users).set({ status: 'disabled' }).where(eq(users.id, accountId))
    expect(await requester.resolve(id)).toBeNull()
    await harness.db.update(users).set({ status: 'active' }).where(eq(users.id, accountId))
    await harness.db.delete(externalIdentities).where(eq(externalIdentities.userId, accountId))
    // A matching username/email is not a platform identity link.
    expect(await requester.resolve(id)).toBeNull()
  })

  test('an email already owned by another account is not merged or copied', async () => {
    await adapters().http.authenticate(request(await token({ claims: { email: 'shared@x.io' } })))
    const second = await adapters().http.authenticate(
      request(await token({ subject: ADMIN, claims: { email: 'shared@x.io' } })),
    )
    if (second.kind !== 'authenticated') throw new Error('second identity was not admitted')
    const row = (
      await harness.db.select().from(users).where(eq(users.id, second.identity.actor.user.id))
    )[0]!
    expect(row.email).toBeNull()
    expect(await harness.db.select().from(externalIdentities)).toHaveLength(2)
  })

  test('missing or invalid tokens are unauthorized and a disabled account is forbidden', async () => {
    const http = adapters().http
    await expect(http.authenticate(request(null))).rejects.toMatchObject({ status: 401 })
    await expect(http.authenticate(request('garbage'))).rejects.toMatchObject({ status: 401 })
    const admitted = await http.authenticate(request(await token()))
    if (admitted.kind !== 'authenticated') throw new Error('identity was not admitted')
    await harness.db
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, admitted.identity.actor.user.id))
    await expect(http.authenticate(request(await token()))).rejects.toMatchObject({
      status: 403,
      code: 'account-disabled',
    })
  })

  test('WebSocket upgrades admit the same account and re-resolve its current state', async () => {
    const webSocket = adapters().webSocket
    const upgrade = (value: string | null) =>
      webSocket.resolveUpgrade({
        url: 'ws://daemon/ws/tasks?token=ignored',
        header: request(value).header,
      })
    const rejected = await upgrade(null)
    expect(rejected.actor).toBeNull()
    expect(rejected.rejection).toMatchObject({ status: 401 })
    const admitted = await upgrade(await token())
    expect(admitted.rejection).toBeUndefined()
    expect(admitted.actor?.user.username).toBe(externalIdentityUsername('crewstation', SUBJECT))
    expect(webSocket.expiresAt(admitted.credential)).toBeNull()
    expect(webSocket.revalidationKey(admitted.credential)).toContain(admitted.actor!.user.id)
    expect((await webSocket.reresolve(admitted.credential))?.actor.user.id).toBe(
      admitted.actor!.user.id,
    )
    await harness.db
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, admitted.actor!.user.id))
    expect(await webSocket.reresolve(admitted.credential)).toBeNull()
  })
})
