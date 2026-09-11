// RFC-247 T20 / D4 — type-to-confirm on the four delete routes RFC-222 left out.
//
// RFC-222 required a typed confirmation on seven deletes. Four were outside it:
// schedules, memories, cached repos, and single skill files. Their web flows
// confirm more lightly on purpose — a memory row is not an agent definition,
// and its identity is a 120-character TITLE nobody should have to retype.
//
// A token has no dialog, and reaches these over plain REST as well as MCP. So
// the rule applies where the reasoning differs: PAT callers echo the name,
// session callers keep today's behaviour byte-for-byte.
//
// Both halves are asserted for every route. Testing only the refusal would let
// a change that demands confirmation from EVERYONE pass silently, and that
// change is a UX regression rather than a security improvement.

import { describe, expect, test } from 'bun:test'

import type { Hono } from 'hono'
import { createPat } from './helpers/auth/patStore'

import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { agents } from '../src/db/schema'
import { assertTokenDeleteConfirm } from '../src/services/deleteConfirm'
import { memoryCatalogOf } from './helpers/memoryCatalog'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)

// RFC-359 AC-6：两个引擎各跑一遍。
describe('RFC-247 assertTokenDeleteConfirm — the rule itself', () => {
  test('a PAT must echo the exact name', () => {
    expect(() => assertTokenDeleteConfirm({}, 'nightly-audit', 'schedule', 'pat')).toThrow(
      /type the schedule name/,
    )
    expect(() =>
      assertTokenDeleteConfirm({ confirm: 'wrong' }, 'nightly-audit', 'schedule', 'pat'),
    ).toThrow(/does not match/)
    expect(() =>
      assertTokenDeleteConfirm({ confirm: 'nightly-audit' }, 'nightly-audit', 'schedule', 'pat'),
    ).not.toThrow()
  })

  test('a session caller is untouched — no body needed at all', () => {
    // The half that keeps this from becoming a UX regression.
    expect(() => assertTokenDeleteConfirm({}, 'nightly-audit', 'schedule', 'session')).not.toThrow()
    expect(() =>
      assertTokenDeleteConfirm({ confirm: 'anything' }, 'nightly-audit', 'schedule', 'session'),
    ).not.toThrow()
  })

  test('the daemon actor is untouched too', () => {
    expect(() => assertTokenDeleteConfirm({}, 'x', 'schedule', 'daemon')).not.toThrow()
  })
})

interface Harness {
  db: ProviderNeutralDatabase
  app: Hono
  userId: string
  ownedAgentId: string
  patToken: string
  sessionToken: string
}

async function harness(scope: ProviderHttpApplicationScope): Promise<Harness> {
  const db = scope.harness.db
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'pw12345678',
  })
  const ownedAgentId = 'rfc247-delete-owner-agent'
  await db.insert(agents).values({
    id: ownedAgentId,
    name: 'RFC 247 delete owner agent',
    ownerUserId: user.id,
    visibility: 'private',
  })
  const app = (await scope.open()).app
  const { token: patToken } = await createPat({
    db,
    userId: user.id,
    name: 'deleter',
    // A `general` PAT: it reaches these routes over REST, which is exactly why
    // guarding only the MCP tool would have left the hole open.
    scopes: ['memory:delete'],
    purpose: 'general',
  })
  const { token: sessionToken } = await createSession({ db, userId: user.id })
  return { db, app, userId: user.id, ownedAgentId, patToken, sessionToken }
}

async function del(app: Hono, token: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-247 T20 — DELETE /api/memories/:id over a token',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'aw-token-del-',
  },
  (scope) => {
    test('without the title it is refused, and the row survives', async () => {
      const h = await harness(scope)
      const memory = await memoryCatalogOf(h.db).commands.createManual({
        scopeType: 'agent',
        scopeId: h.ownedAgentId,
        title: 'never delete me blindly',
        bodyMd: 'body',
        tags: [],
      })

      const refused = await del(h.app, h.patToken, `/api/memories/${memory.id}?confirm=true`)
      expect(refused.status).toBe(422)
      expect(((await refused.json()) as { code: string }).code).toBe('delete-confirm-required')

      const mismatched = await del(h.app, h.patToken, `/api/memories/${memory.id}?confirm=true`, {
        confirm: 'some other title',
      })
      expect(mismatched.status).toBe(422)
      expect(((await mismatched.json()) as { code: string }).code).toBe('delete-confirm-mismatch')

      // Still there after both refusals.
      const still = await h.app.request(`/api/memories/${memory.id}`, {
        headers: { Authorization: `Bearer ${h.sessionToken}` },
      })
      expect(still.status).toBe(200)
    })

    test('with the exact title it goes through', async () => {
      const h = await harness(scope)
      const memory = await memoryCatalogOf(h.db).commands.createManual({
        scopeType: 'agent',
        scopeId: h.ownedAgentId,
        title: 'delete me deliberately',
        bodyMd: 'body',
        tags: [],
      })
      const ok = await del(h.app, h.patToken, `/api/memories/${memory.id}?confirm=true`, {
        confirm: 'delete me deliberately',
      })
      expect(ok.status).toBe(200)
    })

    test('a SESSION delete still needs only the existing query flag', async () => {
      // Locks the non-regression: the web flow did not gain a typing step.
      const h = await harness(scope)
      const memory = await memoryCatalogOf(h.db).commands.createManual({
        scopeType: 'global',
        scopeId: null,
        title: 'a long title a human should not have to retype',
        bodyMd: 'body',
        tags: [],
      })
      const ok = await del(h.app, h.sessionToken, `/api/memories/${memory.id}?confirm=true`)
      expect(ok.status).toBe(200)
    })

    test('the pre-existing ?confirm=true gate still applies to sessions', async () => {
      // RFC-247 added a rule; it did not remove one.
      const h = await harness(scope)
      const memory = await memoryCatalogOf(h.db).commands.createManual({
        scopeType: 'global',
        scopeId: null,
        title: 'guarded either way',
        bodyMd: 'body',
        tags: [],
      })
      const refused = await del(h.app, h.sessionToken, `/api/memories/${memory.id}`)
      expect(refused.status).toBe(422)
      expect(((await refused.json()) as { code: string }).code).toBe('confirm-required')
    })
  },
)
