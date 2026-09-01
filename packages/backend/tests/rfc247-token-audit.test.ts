// RFC-247 D16 / §6 / T28 / F13 / F14 — the token call audit.
//
// Four properties, each of which fails in a way that is easy to miss:
//
//   · rows appear on BOTH channels, with the fields an operator needs. REST is
//     one middleware and MCP is per-tool, so they can regress independently.
//   · no request body is ever stored. A body-bearing audit table holds MCP env
//     values and repo credentials — a breach surface wearing a control's badge.
//   · an audit failure never breaks the business call (F13). The whole point of
//     making it a side channel is lost the first time it can throw.
//   · retention actually deletes, and deletes only what is past the window.

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tokenAudit, tokenDeleteSnapshot } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  listTokenAudit,
  listTokenAuditForUser,
  pruneTokenAudit,
  recordTokenCall,
  redactSnapshot,
} from '../src/services/tokenAudit'
import { createManualCandidate } from '../src/services/memory'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function configFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc247-audit-')), 'config.json')
  writeFileSync(path, JSON.stringify(DEFAULT_CONFIG))
  return path
}

interface Harness {
  db: DbClient
  app: Hono
  userId: string
  ownedAgentId: string
  patId: string
  patToken: string
  sessionToken: string
}

async function harness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'pw12345678',
  })
  const ownedAgentId = 'rfc247-audit-owner-agent'
  await db.insert(agents).values({
    id: ownedAgentId,
    name: 'RFC 247 audit owner agent',
    ownerUserId: user.id,
    visibility: 'private',
  })
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: configFile(),
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  const { token: patToken, meta } = await createPat({
    db,
    userId: user.id,
    name: 'auditee',
    scopes: [],
    purpose: 'general',
  })
  const { token: sessionToken } = await createSession({ db, userId: user.id })
  return { db, app, userId: user.id, ownedAgentId, patId: meta.id, patToken, sessionToken }
}

describe('RFC-247 — the REST channel writes an audit row', () => {
  test('a token call is recorded with method, path, status and token id', async () => {
    const h = await harness()
    const res = await h.app.request('/api/agents', {
      headers: { Authorization: `Bearer ${h.patToken}` },
    })
    expect(res.status).toBe(200)

    const rows = await listTokenAuditForUser(h.db, h.userId)
    expect(rows.length).toBe(1)
    expect(rows[0]?.channel).toBe('rest')
    expect(rows[0]?.method).toBe('GET')
    expect(rows[0]?.path).toBe('/api/agents')
    expect(rows[0]?.statusCode).toBe(200)
    expect(rows[0]?.patId).toBe(h.patId)
    expect(rows[0]?.userId).toBe(h.userId)
  })

  test('a REFUSED call is recorded too — that is the interesting one', async () => {
    const h = await harness()
    // Empty matrix: no create point.
    const res = await h.app.request('/api/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.patToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    })
    expect(res.status).toBe(403)
    const rows = await listTokenAuditForUser(h.db, h.userId)
    expect(rows.some((r) => r.statusCode === 403 && r.method === 'POST')).toBe(true)
  })

  test('a SESSION call writes nothing — this table is per-token attribution', async () => {
    const h = await harness()
    await h.app.request('/api/agents', {
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(await listTokenAudit(h.db)).toEqual([])
  })

  test('the row carries no body field at all', async () => {
    const h = await harness()
    await h.app.request('/api/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.patToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'has-a-body', secretish: 'sk-live-123' }),
    })
    const rows = await h.db.select().from(tokenAudit)
    expect(rows.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('sk-live-123')
    expect(serialized).not.toContain('has-a-body')
    // Structural, not just this payload: there is no body column to fill.
    expect(Object.keys(rows[0] ?? {})).not.toContain('body')
  })
})

describe('RFC-247 — the MCP channel audits per tool, not per request', () => {
  test('a tools/call row names the tool rather than POST /api/mcp', async () => {
    const h = await harness()
    const res = await h.app.request('/api/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.patToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'describe_capabilities', arguments: {} },
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const rows = await listTokenAuditForUser(h.db, h.userId)
    const mcpRow = rows.find((r) => r.channel === 'mcp')
    expect(mcpRow).toBeDefined()
    expect(mcpRow?.toolName).toBe('describe_capabilities')
    // …and the transport request itself did NOT also produce a REST row: one
    // call should read as one thing in the log.
    expect(rows.some((r) => r.path === '/api/mcp')).toBe(false)
  })
})

describe('RFC-247 F13/F14 — auditing never breaks the call', () => {
  test('an insert failure is swallowed and reported as null', async () => {
    const h = await harness()
    const brokenDb = {
      insert: () => {
        throw new Error('disk is on fire')
      },
    } as unknown as DbClient
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })
    const id = await recordTokenCall(brokenDb, { actor, channel: 'rest', statusCode: 200 })
    expect(id).toBeNull()
  })

  test('a token with no patId records nothing rather than a null-keyed row', async () => {
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
    })
    expect(await recordTokenCall(h.db, { actor, channel: 'rest', statusCode: 200 })).toBeNull()
  })
})

describe('RFC-247 — delete snapshots are kept, and redacted', () => {
  test('a snapshot is written alongside the audit row', async () => {
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })
    const id = await recordTokenCall(h.db, {
      actor,
      channel: 'mcp',
      toolName: 'resource_write',
      resourceKind: 'mcps',
      resourceId: 'm1',
      statusCode: 204,
      deletedSnapshot: {
        id: 'm1',
        name: 'gone',
        config: { env: { API_KEY: 'sk-live-should-not-survive' } },
      },
    })
    expect(id).not.toBeNull()

    const snaps = await h.db.select().from(tokenDeleteSnapshot)
    expect(snaps.length).toBe(1)
    expect(snaps[0]?.auditId).toBe(id ?? '')
    // The record is preserved, the credential is not — a snapshot that kept the
    // key would let it outlive the resource in a table nobody thinks of as
    // holding secrets.
    expect(snaps[0]?.snapshotJson).toContain('gone')
    expect(snaps[0]?.snapshotJson).not.toContain('sk-live-should-not-survive')
    expect(snaps[0]?.snapshotJson).toContain('API_KEY')
  })

  test('redactSnapshot also masks an embedded repo credential', () => {
    const out = redactSnapshot({ id: 't1', repoUrl: 'https://user:tok@example.com/x.git' })
    expect(JSON.stringify(out)).not.toContain('tok@')
  })
})

describe('RFC-247 — retention actually prunes', () => {
  test('rows past the window go; rows inside it stay', async () => {
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })
    const now = 1_800_000_000_000
    const day = 86_400_000
    await recordTokenCall(h.db, { actor, channel: 'rest', statusCode: 200 }, now - 100 * day)
    await recordTokenCall(
      h.db,
      {
        actor,
        channel: 'mcp',
        statusCode: 204,
        resourceKind: 'agents',
        resourceId: 'a1',
        deletedSnapshot: { id: 'a1' },
      },
      now - 95 * day,
    )
    await recordTokenCall(h.db, { actor, channel: 'rest', statusCode: 200 }, now - 10 * day)
    expect((await listTokenAudit(h.db)).length).toBe(3)

    const pruned = await pruneTokenAudit(h.db, 90, now)
    expect(pruned.audits).toBe(2)
    expect(pruned.snapshots).toBe(1)

    const left = await listTokenAudit(h.db)
    expect(left.length).toBe(1)
    expect(left[0]?.createdAt).toBe(now - 10 * day)
    expect((await h.db.select().from(tokenDeleteSnapshot)).length).toBe(0)
  })

  test('a fresh row is never pruned, whatever the window', async () => {
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })
    await recordTokenCall(h.db, { actor, channel: 'rest', statusCode: 200 })
    expect((await pruneTokenAudit(h.db, 1)).audits).toBe(0)
  })
})

// RFC-247 impl-gate P2 — both listings used to `select()` the entire table and
// then filter/sort/slice in JS, which made the `(user_id, created_at)` index
// dead weight and turned a 90-day window into unbounded latency and memory.
// Pushing it into SQL is only safe if the ORDER is identical, hence the
// same-millisecond case: JS `sort()` is stable, bare `ORDER BY created_at DESC`
// is not.
describe('RFC-247 — the audit listings are pushed into SQL', () => {
  async function seed(
    db: DbClient,
    userId: string,
    patId: string,
    username: string,
    at: number[],
  ): Promise<void> {
    const actor = buildActor({
      user: { id: userId, username, displayName: username, role: 'admin', status: 'active' },
      source: 'pat',
      patScopes: [],
      patId,
    })
    for (const when of at) {
      await recordTokenCall(db, { actor, channel: 'rest', statusCode: 200 }, when)
    }
  }

  test('the user filter, the ordering and the limit all hold', async () => {
    const h = await harness()
    const other = await createUser(h.db, {
      username: 'mallory',
      displayName: 'Mallory',
      role: 'user',
      password: 'pw12345678',
    })
    const otherPat = await createPat({
      db: h.db,
      userId: other.id,
      name: 'other',
      scopes: [],
      purpose: 'general',
    })
    const t = 1_800_000_000_000
    await seed(h.db, h.userId, h.patId, 'alice', [t + 1, t + 3, t + 2])
    await seed(h.db, other.id, otherPat.meta.id, 'mallory', [t + 9])

    const mine = await listTokenAuditForUser(h.db, h.userId)
    expect(mine.map((r) => r.createdAt)).toEqual([t + 3, t + 2, t + 1])
    expect(mine.every((r) => r.userId === h.userId)).toBe(true)

    // The other user's newer row is visible to the admin listing and absent
    // from the per-user one — i.e. the WHERE really is a WHERE.
    expect((await listTokenAudit(h.db)).map((r) => r.createdAt)).toEqual([
      t + 9,
      t + 3,
      t + 2,
      t + 1,
    ])
    expect(await listTokenAuditForUser(h.db, h.userId, 2)).toHaveLength(2)
    expect((await listTokenAudit(h.db, 1)).map((r) => r.createdAt)).toEqual([t + 9])
  })

  test('same-millisecond rows keep insertion order, and keep it across calls', async () => {
    const h = await harness()
    const t = 1_800_000_000_000
    await seed(h.db, h.userId, h.patId, 'alice', [t, t, t])

    const first = (await listTokenAudit(h.db)).map((r) => r.id)
    expect(first).toHaveLength(3)
    // ULIDs are monotonic within a millisecond, so insertion order is id ASC.
    expect(first).toEqual([...first].sort())
    expect((await listTokenAudit(h.db)).map((r) => r.id)).toEqual(first)
    expect((await listTokenAuditForUser(h.db, h.userId)).map((r) => r.id)).toEqual(first)
  })

  test('the source keeps the work in SQL — no in-memory filter/sort survives', async () => {
    // A behavioural test cannot tell `WHERE` from `.filter()`; this can, and it
    // is what stops the next refactor from quietly reintroducing the full-table
    // read that the impl-gate flagged.
    const src = await Bun.file(
      resolve(import.meta.dir, '..', 'src/auth/infrastructure/sqliteTokenCallAudit.ts'),
    ).text()
    const listings = src.slice(src.indexOf('async listForUser'))
    expect(listings).not.toContain('.sort(')
    expect(listings).not.toContain('.filter(')
    expect(listings).not.toContain('.slice(')
    expect(listings).toContain('.limit(')
    expect(listings).toContain('eq(tokenAudit.userId')
  })
})

describe('RFC-247 D8 — who can read the audit', () => {
  test('the owner reads their own through /api/auth/pats/audit', async () => {
    const h = await harness()
    await h.app.request('/api/agents', { headers: { Authorization: `Bearer ${h.patToken}` } })
    const res = await h.app.request('/api/auth/pats/audit', {
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0)
  })

  test('a token cannot read the audit, not even its own', async () => {
    // D6: the whole /api/auth/* surface is closed to tokens. An audit log a
    // compromised token could read is a map of what else to try.
    const h = await harness()
    const res = await h.app.request('/api/auth/pats/audit', {
      headers: { Authorization: `Bearer ${h.patToken}` },
    })
    expect(res.status).toBe(403)
  })

  test('the admin platform view is read-only and token-closed', async () => {
    const h = await harness()
    const ok = await h.app.request('/api/tokens', {
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(ok.status).toBe(200)
    const byToken = await h.app.request('/api/tokens', {
      headers: { Authorization: `Bearer ${h.patToken}` },
    })
    expect(byToken.status).toBe(403)
    // No admin revoke endpoint exists at all.
    const revoke = await h.app.request('/api/tokens/x', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(revoke.status).toBe(404)
  })

  test('AC-43 — an admin cannot revoke SOMEONE ELSE’s token', async () => {
    // The real shape of the rule: the only revoke endpoint is the owner's own,
    // and it refuses a token belonging to another user even for an admin. The
    // admin's lever for a compromised account is disabling the account, which
    // revokes everything at once and is the honest action to take.
    const h = await harness()
    const bob = await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const { meta: bobPat } = await createPat({
      db: h.db,
      userId: bob.id,
      name: 'bobs-token',
      scopes: [],
      purpose: 'general',
    })

    // h.sessionToken belongs to alice, an ADMIN.
    const res = await h.app.request(`/api/auth/pats/${bobPat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(res.status).toBe(403)

    // …and Bob's token is still live.
    const stillThere = await listTokenAudit(h.db)
    expect(Array.isArray(stillThere)).toBe(true)
    const bobsPats = await (await import('../src/auth/patStore')).listPatsForUser(h.db, bob.id)
    expect(bobsPats[0]?.revokedAt).toBeNull()
  })
})

describe('RFC-247 F14 — a lost snapshot is marked, not silently absent', () => {
  test('snapshot_failed is set when the snapshot cannot be stored', async () => {
    // Without the marker, a row whose evidence was ATTEMPTED AND LOST looks
    // identical to one that never needed evidence — an investigator would read
    // it as "nothing to capture" rather than "capture failed".
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })

    const circular: Record<string, unknown> = { id: 'x' }
    circular.self = circular // JSON.stringify throws

    const id = await recordTokenCall(h.db, {
      actor,
      channel: 'mcp',
      toolName: 'resource_write',
      resourceKind: 'agents',
      resourceId: 'a1',
      statusCode: 204,
      deletedSnapshot: circular,
    })
    expect(id).not.toBeNull()

    // The audit row survives (F13: auditing never breaks the call)…
    const rows = await h.db.select().from(tokenAudit)
    const row = rows.find((r) => r.id === id)
    expect(row).toBeDefined()
    // …no snapshot was written…
    expect((await h.db.select().from(tokenDeleteSnapshot)).length).toBe(0)
    // …and the row says so.
    expect(row?.snapshotFailed).toBe(true)
  })

  test('a successful snapshot leaves the flag clear', async () => {
    const h = await harness()
    const actor = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: [],
      patId: h.patId,
    })
    const id = await recordTokenCall(h.db, {
      actor,
      channel: 'mcp',
      resourceKind: 'agents',
      resourceId: 'a1',
      statusCode: 204,
      deletedSnapshot: { id: 'a1', name: 'fine' },
    })
    const row = (await h.db.select().from(tokenAudit)).find((r) => r.id === id)
    expect(row?.snapshotFailed).toBe(false)
  })
})

describe('RFC-247 AC-20 — the snapshot is captured in PRODUCTION, not just in a unit test', () => {
  test('a token DELETE through the real route writes a snapshot of the row', async () => {
    // The original test called `recordTokenCall` directly and hand-fed it a
    // snapshot, so it proved the TABLE worked and nothing about the pipeline.
    // In production the audit hook runs after the response — by then the row is
    // gone — so no real delete had ever produced one.
    const h = await harness()
    const memory = await createManualCandidate(h.db, {
      scopeType: 'agent',
      scopeId: h.ownedAgentId,
      title: 'about to be deleted',
      bodyMd: 'the body worth keeping a copy of',
      tags: [],
    })

    const { token } = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'deleter',
      scopes: ['memory:delete'],
      purpose: 'general',
    })

    const res = await h.app.request(`/api/memories/${memory.id}?confirm=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'about to be deleted' }),
    })
    expect(res.status).toBe(200)

    // The audit hook is fire-and-forget, so settle the microtask queue.
    await new Promise((r) => setTimeout(r, 50))

    const snaps = await h.db.select().from(tokenDeleteSnapshot)
    expect(snaps.length).toBe(1)
    // The CONTENT is the point — metadata alone answers "who deleted what" but
    // not "what was it", and the second question is the one that survives.
    expect(snaps[0]?.snapshotJson).toContain('about to be deleted')
    expect(snaps[0]?.snapshotJson).toContain('the body worth keeping a copy of')

    const audits = await listTokenAudit(h.db)
    expect(audits.some((a) => a.id === snaps[0]?.auditId)).toBe(true)
  })

  test('a SESSION delete writes no snapshot — this table is token attribution', async () => {
    const h = await harness()
    const memory = await createManualCandidate(h.db, {
      scopeType: 'agent',
      scopeId: h.ownedAgentId,
      title: 'session deletes leave no audit',
      bodyMd: 'body',
      tags: [],
    })
    const res = await h.app.request(`/api/memories/${memory.id}?confirm=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${h.sessionToken}` },
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect((await h.db.select().from(tokenDeleteSnapshot)).length).toBe(0)
  })

  test('a REFUSED delete leaves no snapshot — nothing was destroyed', async () => {
    const h = await harness()
    const memory = await createManualCandidate(h.db, {
      // PATs never carry resource-acl:bypass. Anchor this confirmation test to
      // a resource the token's account owns so only the type-to-confirm gate is
      // under test.
      scopeType: 'agent',
      scopeId: h.ownedAgentId,
      title: 'survives the refusal',
      bodyMd: 'body',
      tags: [],
    })
    const { token } = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'deleter2',
      scopes: ['memory:delete'],
      purpose: 'general',
    })
    // Wrong confirmation → 422 before the row is touched.
    const res = await h.app.request(`/api/memories/${memory.id}?confirm=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'wrong name' }),
    })
    expect(res.status).toBe(422)
    await new Promise((r) => setTimeout(r, 50))
    expect((await h.db.select().from(tokenDeleteSnapshot)).length).toBe(0)
  })
})
