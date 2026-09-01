// RFC-321 AC-1/2/8/9 — the personal credential surface is session/self only,
// never echoes plaintext, and stays transactionally coupled to the admin
// connection trust boundary.

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { buildActor } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import {
  codeHostConnections,
  repositoryTransportConnections,
  userRepositoryTransportCredentials,
} from '../src/db/schema'
import { createApp } from '../src/server'
import type { AppDeps } from '../src/server'
import { mountAccountRepositoryTransportCredentialRoutes } from '../src/routes/accountRepositoryTransportCredentials'
import { composeRepositoryTransportCredentials } from '../src/modules/source-control/composition'
import { SQLiteRepositoryTransportCredentialRepository } from '../src/modules/source-control/infrastructure/sqliteRepositoryTransportCredentialRepository'
import { createUser } from '../src/services/users'
import { errorHandler } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 21))
const DAEMON_TOKEN = 'd'.repeat(64)
const GLOBAL_TOKEN = 'aw-fixture-global-credential-9001' // gitleaks:allow
const PERSONAL_TOKEN = 'aw-fixture-alice-credential-7001' // gitleaks:allow

interface CredentialSummary {
  provider: 'gitlab' | 'github'
  connectionGeneration: string
  endpointBindingDigest: string
  configured: boolean
  tokenHint: string | null
}

async function fixture() {
  const db = createInMemoryDb(MIGRATIONS)
  const probedTokens: string[] = []
  const [admin, alice, bob] = await Promise.all([
    createUser(db, {
      username: 'rfc321-admin',
      displayName: 'RFC 321 Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    }),
    createUser(db, {
      username: 'rfc321-alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    }),
    createUser(db, {
      username: 'rfc321-bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    }),
  ])
  const [adminSession, aliceSession, bobSession] = await Promise.all([
    createSession({ db, userId: admin.id }),
    createSession({ db, userId: alice.id }),
    createSession({ db, userId: bob.id }),
  ])
  const repositoryTransport = composeRepositoryTransportCredentials(
    new SQLiteRepositoryTransportCredentialRepository(db),
    box,
  )
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: box,
    repositoryTransport,
    codeHostFetch: async (_url, init) => {
      const token = new Headers(init?.headers).get('private-token') ?? ''
      probedTokens.push(token)
      if (token.includes('invalid')) {
        return new Response(null, { status: 401 })
      }
      return Response.json({ username: token.endsWith('7001') ? 'alice-code-host' : 'draft-user' })
    },
  })
  const call = async (
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    await app.request(path, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  const configured = await call(adminSession.token, 'PUT', '/api/code-hosts/gitlab', {
    baseUrl: 'https://gitlab.example/api/v4',
    token: GLOBAL_TOKEN,
  })
  expect(configured.status).toBe(200)

  return {
    db,
    app,
    call,
    admin,
    alice,
    bob,
    adminToken: adminSession.token,
    aliceToken: aliceSession.token,
    bobToken: bobSession.token,
    probedTokens,
  }
}

async function summaryFor(
  call: Awaited<ReturnType<typeof fixture>>['call'],
  token: string,
): Promise<CredentialSummary> {
  const response = await call(token, 'GET', '/api/account/code-host-push-credentials')
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { items: CredentialSummary[] }
  expect(payload.items).toHaveLength(1)
  return payload.items[0]!
}

describe('RFC-321 personal code-host push credential HTTP surface', () => {
  test('session can save/replace/delete only its own sealed value and never read plaintext', async () => {
    const h = await fixture()
    const initial = await summaryFor(h.call, h.aliceToken)
    expect(initial).toMatchObject({ provider: 'gitlab', configured: false, tokenHint: null })

    const saved = await h.call(
      h.aliceToken,
      'PUT',
      '/api/account/code-host-push-credentials/gitlab',
      {
        token: PERSONAL_TOKEN,
        connectionGeneration: initial.connectionGeneration,
        endpointBindingDigest: initial.endpointBindingDigest,
      },
    )
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain(PERSONAL_TOKEN)
    expect(JSON.parse(savedText)).toMatchObject({ configured: true, tokenHint: '7001' })

    const row = h.db
      .select()
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.userId, h.alice.id))
      .get()
    expect(row).toBeDefined()
    expect(row!.tokenEnc).not.toContain(PERSONAL_TOKEN)
    expect(box.unseal(row!.tokenEnc)).toBe(PERSONAL_TOKEN)

    const bob = await summaryFor(h.call, h.bobToken)
    expect(bob).toMatchObject({ configured: false, tokenHint: null })

    const replacement = 'aw-fixture-alice-replacement-8112' // gitleaks:allow
    const replaced = await h.call(
      h.aliceToken,
      'PUT',
      '/api/account/code-host-push-credentials/gitlab',
      {
        token: replacement,
        connectionGeneration: initial.connectionGeneration,
        endpointBindingDigest: initial.endpointBindingDigest,
      },
    )
    expect(replaced.status).toBe(200)
    expect(await replaced.json()).toMatchObject({ configured: true, tokenHint: '8112' })

    const removed = await h.call(
      h.aliceToken,
      'DELETE',
      '/api/account/code-host-push-credentials/gitlab',
    )
    expect(await removed.json()).toEqual({ removed: true })
    const removedAgain = await h.call(
      h.aliceToken,
      'DELETE',
      '/api/account/code-host-push-credentials/gitlab',
    )
    expect(await removedAgain.json()).toEqual({ removed: false })
  })

  test('PAT, daemon, anonymous, and stale binding inputs fail closed without echoing the token', async () => {
    const h = await fixture()
    const { token: pat } = await createPat({
      db: h.db,
      userId: h.alice.id,
      name: 'rfc321-all-grants',
      purpose: 'general',
      scopes: ['settings:write'],
    })
    const patResponse = await h.call(pat, 'GET', '/api/account/code-host-push-credentials')
    expect(patResponse.status).toBe(403)
    expect(await patResponse.json()).toMatchObject({ code: 'token-forbidden-route' })

    const daemonResponse = await h.call(
      DAEMON_TOKEN,
      'GET',
      '/api/account/code-host-push-credentials',
    )
    expect(daemonResponse.status).toBe(403)
    expect(await daemonResponse.json()).toMatchObject({ code: 'session-required' })
    expect((await h.call(null, 'GET', '/api/account/code-host-push-credentials')).status).toBe(401)

    const summary = await summaryFor(h.call, h.aliceToken)
    const staleCanary = 'aw-fixture-stale-secret-6221' // gitleaks:allow
    const stale = await h.call(
      h.aliceToken,
      'PUT',
      '/api/account/code-host-push-credentials/gitlab',
      {
        token: staleCanary,
        connectionGeneration: `${summary.connectionGeneration}-stale`,
        endpointBindingDigest: summary.endpointBindingDigest,
      },
    )
    expect(stale.status).toBe(409)
    const staleText = await stale.text()
    expect(staleText).not.toContain(staleCanary)
    expect(JSON.parse(staleText)).toMatchObject({ code: 'code-host-push-credential-stale' })
  })

  test('a session whose current account disappears fails closed with a named subject error', async () => {
    const h = await fixture()
    const app = new Hono()
    const actor = buildActor({
      user: {
        id: h.alice.id,
        username: h.alice.username,
        displayName: h.alice.displayName,
        role: h.alice.role,
        status: 'active',
      },
      source: 'session',
    })
    const injectActor: MiddlewareHandler = async (c, next) => {
      c.set('actor', actor)
      await next()
    }
    app.use('*', injectActor)
    app.onError(errorHandler)
    mountAccountRepositoryTransportCredentialRoutes(app, { db: h.db, secretBox: box } as AppDeps, {
      credentials: composeRepositoryTransportCredentials(
        new SQLiteRepositoryTransportCredentialRepository(h.db),
        box,
      ).ownCredentials,
      currentSubjects: {
        async resolveCurrentSubject() {
          return null
        },
      },
    })

    const response = await app.request('/api/account/code-host-push-credentials')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'account-subject-unavailable' })
  })

  test('identity probe validates a draft or stored personal token and never falls back to global', async () => {
    const h = await fixture()
    const summary = await summaryFor(h.call, h.aliceToken)
    const draftToken = 'aw-fixture-draft-credential-5005' // gitleaks:allow
    const draft = await h.call(
      h.aliceToken,
      'POST',
      '/api/account/code-host-push-credentials/gitlab/test',
      {
        token: draftToken,
        connectionGeneration: summary.connectionGeneration,
        endpointBindingDigest: summary.endpointBindingDigest,
      },
    )
    expect(draft.status).toBe(200)
    const draftText = await draft.text()
    expect(draftText).not.toContain(draftToken)
    expect(JSON.parse(draftText)).toMatchObject({ ok: true, login: 'draft-user' })

    const absent = await h.call(
      h.aliceToken,
      'POST',
      '/api/account/code-host-push-credentials/gitlab/test',
      {
        connectionGeneration: summary.connectionGeneration,
        endpointBindingDigest: summary.endpointBindingDigest,
      },
    )
    expect(absent.status).toBe(422)
    expect(await absent.json()).toMatchObject({ code: 'code-host-push-credential-unavailable' })
    expect(h.probedTokens).toEqual([draftToken])
    expect(h.probedTokens).not.toContain(GLOBAL_TOKEN)

    await h.call(h.aliceToken, 'PUT', '/api/account/code-host-push-credentials/gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: summary.connectionGeneration,
      endpointBindingDigest: summary.endpointBindingDigest,
    })
    const stored = await h.call(
      h.aliceToken,
      'POST',
      '/api/account/code-host-push-credentials/gitlab/test',
      {
        connectionGeneration: summary.connectionGeneration,
        endpointBindingDigest: summary.endpointBindingDigest,
      },
    )
    expect(stored.status).toBe(200)
    expect(await stored.json()).toMatchObject({ ok: true, login: 'alice-code-host' })

    const invalidToken = 'aw-fixture-invalid-credential-4004' // gitleaks:allow
    const invalid = await h.call(
      h.aliceToken,
      'POST',
      '/api/account/code-host-push-credentials/gitlab/test',
      {
        token: invalidToken,
        connectionGeneration: summary.connectionGeneration,
        endpointBindingDigest: summary.endpointBindingDigest,
      },
    )
    expect(invalid.status).toBe(200)
    const invalidText = await invalid.text()
    expect(invalidText).not.toContain(invalidToken)
    expect(JSON.parse(invalidText)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(h.probedTokens).toEqual([draftToken, PERSONAL_TOKEN, invalidToken])
  })

  test('token-only rotation preserves personal rows; rebind and delete require count-bound confirmation', async () => {
    const h = await fixture()
    const initial = await summaryFor(h.call, h.aliceToken)
    await h.call(h.aliceToken, 'PUT', '/api/account/code-host-push-credentials/gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: initial.connectionGeneration,
      endpointBindingDigest: initial.endpointBindingDigest,
    })

    const rotated = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.example/api/v4',
      token: 'aw-fixture-global-rotated-9002', // gitleaks:allow
      expectedConnectionGeneration: initial.connectionGeneration,
    })
    expect(rotated.status).toBe(200)
    expect(await rotated.json()).toMatchObject({ personalPushCredentialCount: 1 })
    expect(h.db.select().from(userRepositoryTransportCredentials).all()).toHaveLength(1)

    const rebind = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.example/platform/api/v4',
      expectedConnectionGeneration: initial.connectionGeneration,
    })
    expect(rebind.status).toBe(409)
    const conflict = (await rebind.json()) as {
      code: string
      details: {
        personalPushCredentialCount: number
        expectedConnectionGeneration: string
        confirmCredentialRevocationDigest: string
      }
    }
    expect(conflict).toMatchObject({
      code: 'code-host-transport-rebind-confirmation-required',
      details: { personalPushCredentialCount: 1 },
    })
    expect(h.db.select().from(userRepositoryTransportCredentials).all()).toHaveLength(1)

    const competingRebind = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.example/competing/api/v4',
      expectedConnectionGeneration: initial.connectionGeneration,
    })
    expect(competingRebind.status).toBe(409)
    const competingConflict = (await competingRebind.json()) as typeof conflict

    const confirmed = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.example/platform/api/v4',
      expectedConnectionGeneration: conflict.details.expectedConnectionGeneration,
      confirmCredentialRevocationDigest: conflict.details.confirmCredentialRevocationDigest,
    })
    expect(confirmed.status).toBe(200)
    expect(h.db.select().from(userRepositoryTransportCredentials).all()).toHaveLength(0)

    const staleCompetingWriter = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.example/competing/api/v4',
      expectedConnectionGeneration: competingConflict.details.expectedConnectionGeneration,
      confirmCredentialRevocationDigest:
        competingConflict.details.confirmCredentialRevocationDigest,
    })
    expect(staleCompetingWriter.status).toBe(409)
    expect(await staleCompetingWriter.json()).toMatchObject({
      code: 'code-host-push-credential-stale',
    })
    expect(h.db.select().from(codeHostConnections).get()?.baseUrl).toBe(
      'https://gitlab.example/platform/api/v4',
    )

    const rebound = await summaryFor(h.call, h.aliceToken)
    await h.call(h.aliceToken, 'PUT', '/api/account/code-host-push-credentials/gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: rebound.connectionGeneration,
      endpointBindingDigest: rebound.endpointBindingDigest,
    })
    const deleteConflict = await h.call(h.adminToken, 'DELETE', '/api/code-hosts/gitlab')
    expect(deleteConflict.status).toBe(409)
    const deleteBody = (await deleteConflict.json()) as {
      details: {
        expectedConnectionGeneration: string
        confirmCredentialRevocationDigest: string
      }
    }
    const deleted = await h.call(h.adminToken, 'DELETE', '/api/code-hosts/gitlab', {
      expectedConnectionGeneration: deleteBody.details.expectedConnectionGeneration,
      confirmCredentialRevocationDigest: deleteBody.details.confirmCredentialRevocationDigest,
    })
    expect(deleted.status).toBe(200)
    expect(h.db.select().from(repositoryTransportConnections).all()).toHaveLength(0)
    expect(h.db.select().from(userRepositoryTransportCredentials).all()).toHaveLength(0)
  })

  test('projection failure rolls both connection tables back to the old ciphertext and revision', async () => {
    const h = await fixture()
    const integrationBefore = h.db.select().from(codeHostConnections).get()!
    const projectionBefore = h.db.select().from(repositoryTransportConnections).get()!
    h.db.$client.exec(`
      CREATE TRIGGER rfc321_fail_projection_update
      BEFORE UPDATE ON repository_transport_connections
      BEGIN
        SELECT RAISE(ABORT, 'projection unavailable');
      END;
    `)

    const failed = await h.call(h.adminToken, 'PUT', '/api/code-hosts/gitlab', {
      baseUrl: integrationBefore.baseUrl,
      token: 'aw-fixture-must-rollback-3119', // gitleaks:allow
    })
    expect(failed.status).toBe(500)
    const integrationAfter = h.db.select().from(codeHostConnections).get()!
    const projectionAfter = h.db.select().from(repositoryTransportConnections).get()!
    expect(integrationAfter.tokenEnc).toBe(integrationBefore.tokenEnc)
    expect(projectionAfter.globalTokenEnc).toBe(projectionBefore.globalTokenEnc)
    expect(projectionAfter.credentialRevision).toBe(projectionBefore.credentialRevision)
  })

  test('write limiter is keyed by user and rejects the twenty-first change in one minute', async () => {
    const h = await fixture()
    const initial = await summaryFor(h.call, h.aliceToken)
    for (let index = 0; index < 20; index += 1) {
      const response = await h.call(
        h.aliceToken,
        'PUT',
        '/api/account/code-host-push-credentials/gitlab',
        {
          token: `aw-fixture-rate-limit-${String(index).padStart(4, '0')}`, // gitleaks:allow
          connectionGeneration: initial.connectionGeneration,
          endpointBindingDigest: initial.endpointBindingDigest,
        },
      )
      expect(response.status).toBe(200)
    }
    const limited = await h.call(
      h.aliceToken,
      'PUT',
      '/api/account/code-host-push-credentials/gitlab',
      {
        token: 'aw-fixture-rate-limit-blocked', // gitleaks:allow
        connectionGeneration: initial.connectionGeneration,
        endpointBindingDigest: initial.endpointBindingDigest,
      },
    )
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ code: 'code-host-push-credential-rate-limited' })
  })
})
