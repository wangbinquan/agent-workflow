// RFC-212 PR-2 — revalidation behaviour (AC-1 … AC-4b, AC-8, T6 ratchet).
//
// Drives `revalidateAllConnections` directly against a real in-memory DB with
// fake sockets that record close(code, reason) and expose their mutable
// `ws.data.actor`. That keeps the auth logic deterministic — no Bun.serve
// timing — while still exercising the real gates (taskVisibleTo, adminShortCircuit
// reads ws.data.actor per frame) and the real credential re-resolution.
//
// The end-to-end wire path (a live socket actually closing with code 4401/4403)
// rides on the existing real-server WS suites once the frame path is unchanged;
// this file owns the decision logic. See design/RFC-212 §7.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { createLogger } from '../src/util/log'
import { createSession } from '../src/auth/sessionStore'
import { describeCredential } from '../src/auth/session'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, taskCollaborators, userSessions, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import { revokeSession } from '../src/auth/sessionStore'
import { disableUser, patchUser } from '../src/services/users'
import {
  liveConnections,
  resetConnectionsForTest,
  revalidateAllConnections,
  trackConnection,
  WS_CLOSE_AUTH_REVOKED,
  WS_CLOSE_NOT_VISIBLE,
} from '../src/ws/connections'
import type { AnyChannelParams, WsConnectionData, WsCredential } from '../src/ws/registry'
import type { Actor } from '../src/auth/actor'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test')

interface FakeWs {
  ws: ServerWebSocket<WsConnectionData>
  closes: Array<{ code: number; reason: string }>
}

function fakeConn(actor: Actor, credential: WsCredential, channel: AnyChannelParams): FakeWs {
  const closes: Array<{ code: number; reason: string }> = []
  const data: WsConnectionData = {
    channel,
    actor,
    credential,
    closing: false,
    unsubscribe: () => {},
    visibilityCache: new Map(),
  }
  const ws = {
    data,
    close(code: number, reason: string) {
      closes.push({ code, reason })
    },
  } as unknown as ServerWebSocket<WsConnectionData>
  return { ws, closes }
}

async function seedUser(
  db: DbClient,
  username: string,
  role: 'admin' | 'user',
): Promise<{ id: string; actor: Actor; credential: WsCredential; token: string }> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role,
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  const actor = buildActor({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role,
      status: 'active',
    },
    source: 'session',
  })
  const fp = describeCredential(token)
  const credential: WsCredential =
    fp.kind === 'daemon' ? { kind: 'daemon' } : { ...fp, expiresAt: null }
  return { id: user.id, actor, credential, token }
}

async function seedTask(db: DbClient, ownerUserId: string): Promise<string> {
  const workflowId = `wf_${ownerUserId}`
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: '{}', createdAt: 0, updatedAt: 0 })
  const taskId = `task_${ownerUserId}`
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId,
  })
  return taskId
}

afterEach(() => {
  resetConnectionsForTest()
})

describe('RFC-212 AC-1 — task member removal closes the task socket', () => {
  test('member sees the task before removal, socket closes 4403 after (positive control included)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await seedUser(db, 'owner', 'user')
    const member = await seedUser(db, 'member', 'user')
    const taskId = await seedTask(db, owner.id)
    await db.insert(taskCollaborators).values({
      taskId,
      userId: member.id,
      role: 'collaborator',
      addedBy: owner.id,
      addedAt: Date.now(),
    })

    const conn = fakeConn(member.actor, member.credential, { kind: 'task', taskId })
    trackConnection(conn.ws)

    // Positive control: while a member, revalidation keeps the socket open.
    const before = await revalidateAllConnections({ db, log }, 'task-members-changed')
    expect(conn.closes).toEqual([])
    expect(before.refreshed).toBe(1)
    expect(before.closedGate).toBe(0)

    // Remove the member (owner keeps the task), then revalidate. Remove via a
    // direct DB write, NOT the service — updateTaskMembers fires its own
    // fire-and-forget trigger, which would race this deterministic assertion.
    // (That the service DOES fire the trigger is covered by the T6 ratchet and
    // the AC-1-via-service end-to-end note below.)
    await db.delete(taskCollaborators).where(eq(taskCollaborators.taskId, taskId))
    const after = await revalidateAllConnections({ db, log }, 'task-members-changed')
    expect(conn.closes).toEqual([{ code: WS_CLOSE_NOT_VISIBLE, reason: 'task-not-visible' }])
    expect(after.closedGate).toBe(1)
    // Closed connections are untracked, so a second pass sees nothing.
    expect(liveConnections()).toEqual([])
  })
})

describe('RFC-212 AC-2 — demotion refreshes the actor (admin short-circuit + permission set)', () => {
  test('a demoted admin loses tasks:read:all: task socket for a foreign task closes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await seedUser(db, 'owner', 'user')
    const admin = await seedUser(db, 'root', 'admin')
    // A second admin so demoting the first is not blocked by last-admin protection.
    await seedUser(db, 'root2', 'admin')
    const taskId = await seedTask(db, owner.id)

    // The admin can see a task it does not own via tasks:read:all.
    const conn = fakeConn(admin.actor, admin.credential, { kind: 'task', taskId })
    trackConnection(conn.ws)
    const before = await revalidateAllConnections({ db, log }, 'user-patched')
    expect(conn.closes).toEqual([])
    // White-box: the actor object was replaced (not merely mutated in place).
    expect(conn.ws.data.actor).not.toBe(admin.actor)
    expect(conn.ws.data.actor.user.role).toBe('admin')
    expect(before.refreshed).toBe(1)

    // Demote to user via the real Web-UI path.
    await patchUser(db, admin.id, { role: 'user' })
    await revalidateAllConnections({ db, log }, 'user-patched')
    expect(conn.ws.data.actor.user.role).toBe('user')
    expect(conn.ws.data.actor.permissions.has('tasks:read:all')).toBe(false)
    expect(conn.closes).toEqual([{ code: WS_CLOSE_NOT_VISIBLE, reason: 'task-not-visible' }])
  })
})

describe('RFC-212 AC-3 — revoked / disabled credentials close with 4401', () => {
  test('revoking the session closes the socket regardless of channel', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await seedUser(db, 'alice', 'user')
    const conn = fakeConn(user.actor, user.credential, { kind: 'workflows' })
    trackConnection(conn.ws)

    await revokeSession(db, (await db.select().from(userSessions).limit(1))[0]!.id)
    await revalidateAllConnections({ db, log }, 'session-revoked')
    expect(conn.closes).toEqual([{ code: WS_CLOSE_AUTH_REVOKED, reason: 'auth-revoked' }])
  })

  test('disabling the user closes even a silent socket (no frame required)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const admin = await seedUser(db, 'root', 'admin')
    const victim = await seedUser(db, 'victim', 'user')
    const conn = fakeConn(victim.actor, victim.credential, { kind: 'memories' })
    trackConnection(conn.ws)

    await disableUser(db, victim.id, Date.now(), admin.id)
    await revalidateAllConnections({ db, log }, 'user-disabled')
    expect(conn.closes).toEqual([{ code: WS_CLOSE_AUTH_REVOKED, reason: 'auth-revoked' }])
  })
})

describe('RFC-212 AC-4 — cache handling by channel kind', () => {
  test('AC-4a: a caching channel has its visibility cache cleared on revalidation', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await seedUser(db, 'alice', 'user')
    const conn = fakeConn(user.actor, user.credential, { kind: 'workflows' })
    conn.ws.data.visibilityCache.set('wf:stale', true)
    trackConnection(conn.ws)

    await revalidateAllConnections({ db, log }, 'resource-acl-changed')
    expect(conn.ws.data.visibilityCache.size).toBe(0)
    expect(conn.closes).toEqual([])
  })

  test('AC-4b: an uncached channel is not closed and keeps working via the fresh actor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await seedUser(db, 'alice', 'user')
    const conn = fakeConn(user.actor, user.credential, { kind: 'scheduled-tasks' })
    trackConnection(conn.ws)

    const stats = await revalidateAllConnections({ db, log }, 'resource-acl-changed')
    expect(conn.closes).toEqual([])
    expect(stats.refreshed).toBe(1)
    // Cache stays empty (nothing to clear) — the actor is what got refreshed.
    expect(conn.ws.data.visibilityCache.size).toBe(0)
  })
})

describe('RFC-212 AC-8 — revalidation does not write last_used_at', () => {
  test('a full rescan touches no user_sessions row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await seedUser(db, 'alice', 'user')
    const conn = fakeConn(user.actor, user.credential, { kind: 'workflows' })
    trackConnection(conn.ws)
    const before = (await db.select().from(userSessions).limit(1))[0]!.lastUsedAt

    await revalidateAllConnections({ db, log }, 'resource-acl-changed', before + 60_000)
    expect((await db.select().from(userSessions).limit(1))[0]!.lastUsedAt).toBe(before)
  })
})

describe('RFC-212 T6 — write-surface ratchet', () => {
  // The audit's lesson: a function-body-level check ("this function calls
  // triggerRevalidation") is coarser than the bug (patchUser calling it only in
  // its role branch). Assert at the WRITE surface instead: any function that
  // narrows a credential/authorization must fire the trigger.
  const SRC = resolve(import.meta.dir, '..', 'src')

  function fnBodyContaining(file: string, marker: RegExp): { body: string; found: boolean } {
    const text = readFileSync(file, 'utf8')
    const idx = text.search(marker)
    if (idx < 0) return { body: '', found: false }
    // marker matches the function signature itself; slice to the next export.
    const after = text.slice(idx)
    const next = after.indexOf('\nexport ', 1)
    return { body: after.slice(0, next < 0 ? undefined : next), found: true }
  }

  test('every credential/authorization write point fires triggerRevalidation after its write', () => {
    // Anchor each on the FUNCTION SIGNATURE, not on a statement shape — the
    // touch-path `db.update(userSessions).set({ lastUsedAt })` otherwise lets a
    // lazy statement regex span from the wrong function into the right one.
    const points: Array<{ file: string; marker: RegExp; reason: string }> = [
      {
        file: 'auth/sessionStore.ts',
        marker: /export async function revokeSession\(/,
        reason: 'session-revoked',
      },
      {
        file: 'auth/sessionStore.ts',
        marker: /export async function revokeAllSessionsForUser\(/,
        reason: 'sessions-revoked-bulk',
      },
      {
        file: 'auth/patStore.ts',
        marker: /export async function revokePat\(/,
        reason: 'pat-revoked',
      },
      {
        file: 'services/userIdentities.ts',
        marker: /export async function deleteIdentity\(/,
        reason: 'identity-deleted',
      },
      {
        file: 'services/users.ts',
        marker: /export async function disableUser\(/,
        reason: 'user-disabled',
      },
      {
        file: 'services/users.ts',
        marker: /export async function patchUser\(/,
        reason: 'user-patched',
      },
      {
        file: 'services/taskCollab.ts',
        marker: /export async function updateTaskMembers\(/,
        reason: 'task-members-changed',
      },
      {
        file: 'services/resourceAcl.ts',
        marker: /export async function updateResourceAcl\(/,
        reason: 'resource-acl-changed',
      },
    ]
    const offenders: string[] = []
    for (const p of points) {
      const { body, found } = fnBodyContaining(resolve(SRC, p.file), p.marker)
      if (!found) {
        offenders.push(`${p.file}: write surface for '${p.reason}' not found (marker moved?)`)
        continue
      }
      if (!body.includes('triggerRevalidation(')) {
        offenders.push(`${p.file}: '${p.reason}' write point does not call triggerRevalidation`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('no other function writes users.role/status without firing the trigger', () => {
    // Catch a NEW write point: scan every service/auth source for a
    // `db.update(users).set(` that assigns role or status, and require its
    // enclosing function to trigger. Frozen allowlist = 0.
    const roots = ['services', 'auth']
    const offenders: string[] = []
    for (const root of roots) {
      const dir = resolve(SRC, root)
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue
        const text = readFileSync(resolve(dir, name), 'utf8')
        const re = /update\(users\)\.set\(([\s\S]{0,120}?)\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          const setBlock = m[1]!
          const setsAuth = /\b(role|status)\b/.test(setBlock)
          if (!setsAuth) continue
          // WIDENING writes (reactivate → status:'active') can only GRANT access,
          // so they never need to close a socket. Only narrowing writes must
          // trigger. A bare `status: 'active'` with no other auth field is the
          // reactivate path; skip it. Everything else must trigger.
          const onlyReactivate =
            /status:\s*'active'/.test(setBlock) &&
            !/\brole\b/.test(setBlock) &&
            !/'disabled'/.test(setBlock)
          if (onlyReactivate) continue
          const start = text.lastIndexOf('export async function', m.index)
          const after = text.slice(start)
          const next = after.indexOf('\nexport ', 1)
          const body = after.slice(0, next < 0 ? undefined : next)
          if (!body.includes('triggerRevalidation(')) {
            offenders.push(
              `${root}/${name}: update(users) sets role/status (narrowing) but does not trigger revalidation`,
            )
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
