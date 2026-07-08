// RFC-152 PR-4 — task channel migration locks.
//
// 1. Explicit stranger-403 upgrade cell for /ws/tasks/{taskId} (前置格).
//    The RFC-054 W2-4 canViewTask upgrade gate existed since long before the
//    registry, but no test probed the WS upgrade itself with a non-member
//    session token (tasks-visibility.test.ts only covers the HTTP routes;
//    ws.test.ts / ws-auth-multi-token.test.ts connect with the daemon token
//    or to gate-less channels). This cell locks the semantics across the
//    migration onto the registry's task upgradeGate: owner + admin upgrade,
//    stranger is refused before open (task is an upgrade-gated channel —
//    frames flow ungated once the connection is allowed, so the whole
//    protection IS the upgrade gate).
//
// 2. Source-level ratchet: server.ts must contain ZERO per-channel branches
//    (`case '<kind>'` / `kind === '<kind>'` / hand-written WS path regexes /
//    direct broadcaster subscriptions). Whitelist = none. Adding a channel
//    means adding a ws/registry.ts spec; scattering a new branch into
//    server.ts goes red here.

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../src/ws/server'
import { WS_CHANNEL_KINDS } from '../src/ws/registry'

type AnyServer = Server<unknown>

const DAEMON_TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  baseUrl: string
  taskId: string
  ownerToken: string
  strangerToken: string
  adminToken: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const owner = await createUser(db, {
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const stranger = await createUser(db, {
    username: 'stranger',
    displayName: 'Stranger',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const ownerToken = (await createSession({ db, userId: owner.id })).token
  const strangerToken = (await createSession({ db, userId: stranger.id })).token
  const adminToken = (await createSession({ db, userId: admin.id })).token

  const taskId = ulid()
  await db.insert(workflows).values({
    id: 'wf-gate',
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'gated-task',
    workflowId: 'wf-gate',
    workflowSnapshot: '{}',
    repoPath: '/tmp/x',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId: owner.id,
  })

  const ws = buildWebSocketAdapter({ daemonToken: DAEMON_TOKEN, db })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request, srv): Promise<Response> {
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return new Response('not-ws', { status: 404 })
      return upgraded
    },
    websocket: ws.handlers,
  })
  return {
    db,
    server,
    baseUrl: `ws://${server.hostname}:${server.port}`,
    taskId,
    ownerToken,
    strangerToken,
    adminToken,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

/** Resolve with the first lifecycle event: 'open', or close-before-open. */
async function probeUpgrade(
  url: string,
): Promise<{ outcome: 'open' } | { outcome: 'closed'; code: number }> {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(url)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolvePromise({ outcome: 'closed', code: 0 })
    }, 800)
    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolvePromise({ outcome: 'open' })
    })
    ws.addEventListener('close', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ outcome: 'closed', code: e.code })
    })
  })
}

describe('RFC-152 — /ws/tasks/{taskId} upgrade gate (canViewTask via registry)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('stranger session token is refused (close-before-open, 403 task-not-visible)', async () => {
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks/${h.taskId}?token=${h.strangerToken}`)
    expect(out.outcome).toBe('closed')
  })

  test('owner session token upgrades cleanly', async () => {
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks/${h.taskId}?token=${h.ownerToken}`)
    expect(out.outcome).toBe('open')
  })

  test('admin session token upgrades cleanly (tasks:read:all)', async () => {
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks/${h.taskId}?token=${h.adminToken}`)
    expect(out.outcome).toBe('open')
  })

  test('nonexistent task refuses even the admin-equivalent daemon token? no — fails closed for users only when row missing', async () => {
    // canViewTask is asked with a missing row → the gate fails closed for
    // EVERYONE (admins included: the row lookup happens before canViewTask).
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks/${ulid()}?token=${h.adminToken}`)
    expect(out.outcome).toBe('closed')
  })
})

describe('RFC-152 — server.ts ratchet: zero per-channel branches (whitelist = none)', () => {
  const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'ws', 'server.ts'), 'utf8')

  test('no `case/kind===` per-channel dispatch for any registry kind', () => {
    for (const kind of WS_CHANNEL_KINDS) {
      expect(src).not.toContain(`case '${kind}'`)
      expect(src).not.toContain(`kind === '${kind}'`)
    }
    // No re-grown scattered dispatch of any shape.
    expect(src).not.toMatch(/\.kind\s*===/)
    expect(src).not.toMatch(/switch\s*\(\s*ch\b/)
  })

  test('no hand-written channel wire surface outside the registry', () => {
    // Path regexes live in the registry specs.
    expect(src).not.toContain('WS_PATH_RE')
    expect(src).not.toMatch(/\/\^\\\/ws\\\//)
    // Subscriptions + hello frames live in gatedSubscribe.
    expect(src).not.toContain('.subscribe(')
    expect(src).not.toContain("type: 'hello'")
    expect(src).not.toContain("from './broadcaster'")
  })

  test('server.ts consumes the registry surface (parse / upgrade gate / open)', () => {
    expect(src).toContain("from './registry'")
    expect(src).toContain('parseWsChannel')
    expect(src).toContain('checkUpgradeGate')
    expect(src).toContain('openWsChannel')
  })
})
