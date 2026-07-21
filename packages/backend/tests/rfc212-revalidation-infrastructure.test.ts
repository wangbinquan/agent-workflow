// RFC-212 PR-1 — revalidation infrastructure (behaviour-neutral).
//
// PR-1 ships only the parts that let a later pass re-check a live socket:
// the connection set, the credential fingerprint, the read-only lookups, and
// the compile-enforced per-channel revalidation matrix. The rescan itself is
// PR-2. Everything here must therefore be provable WITHOUT any behaviour change
// to frame delivery — `rfc152-ws-channel-registry.test.ts`'s two synchronous
// delivery locks stay green untouched, which is the evidence that we did not
// slide back into the rejected design (async revalidation inside the broadcast
// fan-out). See design/RFC-212-ws-authorization-revalidation/design.md §1.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describeCredential } from '../src/auth/session'
import { createSession, hashToken, lookupActiveSessionByHash } from '../src/auth/sessionStore'
import { createPat, lookupActivePatByHash } from '../src/auth/patStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { userPats, users, userSessions } from '../src/db/schema'
import { createUser } from '../src/services/users'
import {
  liveConnectionCount,
  liveConnections,
  resetConnectionsForTest,
  trackConnection,
  untrackConnection,
} from '../src/ws/connections'
import { WS_CHANNELS, type WsChannelKind, type WsConnectionData } from '../src/ws/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function fakeWs(): ServerWebSocket<WsConnectionData> {
  return { data: {} } as unknown as ServerWebSocket<WsConnectionData>
}

afterEach(() => {
  resetConnectionsForTest()
})

describe('RFC-212 T1 — live connection set', () => {
  test('tracks and untracks, and untracking twice is a no-op', () => {
    const a = fakeWs()
    const b = fakeWs()
    expect(liveConnectionCount()).toBe(0)
    trackConnection(a)
    trackConnection(b)
    expect(liveConnectionCount()).toBe(2)
    untrackConnection(a)
    untrackConnection(a)
    expect(liveConnectionCount()).toBe(1)
    expect(liveConnections()).toEqual([b])
  })

  test('liveConnections returns a COPY so the rescan can close while iterating', () => {
    // The rescan closes sockets, and handleClose untracks from under it. If this
    // returned the live Set the iteration would be mutated mid-flight.
    const a = fakeWs()
    trackConnection(a)
    const snapshot = liveConnections()
    untrackConnection(a)
    expect(snapshot).toEqual([a])
    expect(liveConnectionCount()).toBe(0)
  })

  test('both hooks are wired into the ws server (and nowhere channel-specific)', () => {
    // server.ts carries a hard rule — "no per-channel `kind === '…'` branch" —
    // locked by rfc152-ws-task-channel.test.ts. Tracking is channel-agnostic, so
    // it belongs there; assert it actually landed in the two lifecycle hooks.
    // NOTE: this is a source-level lock, not a behaviour test — driving
    // handleOpen/handleClose needs a real Bun server upgrade. It is the weakest
    // form of guard (see design/test-guard-audit-2026-07-21 逃逸机制⑤), so it is
    // scoped tightly: each hook's body is sliced up to the NEXT function
    // declaration, so a call sitting elsewhere in the file cannot satisfy it.
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'ws', 'server.ts'), 'utf8')
    const bodyOf = (decl: string): string => {
      const start = src.indexOf(decl)
      expect(`${decl} found`).toBe(start >= 0 ? `${decl} found` : `${decl} MISSING`)
      const after = src.slice(start + decl.length)
      const next = after.search(/\n {2}(?:async )?function /)
      return next < 0 ? after : after.slice(0, next)
    }
    expect(bodyOf('async function handleOpen').includes('trackConnection(ws)')).toBe(true)
    expect(bodyOf('function handleClose').includes('untrackConnection(ws)')).toBe(true)
    // …and that the two are not the same slice (guards the regex above).
    expect(bodyOf('async function handleOpen').includes('untrackConnection(ws)')).toBe(false)
  })
})

describe('RFC-212 T2 — credential fingerprint, never the raw token', () => {
  test('classifies session / pat / daemon exactly like resolveActor does', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token: sessionToken } = await createSession({ db, userId: user.id })
    const { token: patToken } = await createPat({ db, userId: user.id, name: 'ci', scopes: [] })

    expect(describeCredential(sessionToken)).toEqual({
      kind: 'session',
      hash: hashToken(sessionToken),
    })
    expect(describeCredential(patToken).kind).toBe('pat')
    expect(describeCredential('a'.repeat(64))).toEqual({ kind: 'daemon' })
  })

  test('the fingerprint is a hash — the raw token is not recoverable from it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    const fingerprint = describeCredential(token)
    expect(JSON.stringify(fingerprint).includes(token)).toBe(false)
  })

  test('WsConnectionData declares no raw-credential field', () => {
    // util/log.ts formatVal JSON.stringifies arbitrary objects with no redaction,
    // so one `log.debug('…', { data: ws.data })` while debugging would write a
    // long-lived credential into the rotated daemon log. Keep the shape hostile
    // to that mistake.
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'ws', 'registry.ts'), 'utf8')
    const block = src.slice(
      src.indexOf('export interface WsConnectionData {'),
      src.indexOf('/** Upgrade-time refusal'),
    )
    expect(/^\s*token\s*:/m.test(block)).toBe(false)
    expect(/^\s*rawToken\s*:/m.test(block)).toBe(false)
    expect(block.includes('credential: WsCredential')).toBe(true)
  })
})

describe('RFC-212 T3 — hash-keyed lookups are read-only when asked', () => {
  async function seed(): Promise<{
    db: DbClient
    userId: string
    sessionToken: string
    patToken: string
  }> {
    const db = createInMemoryDb(MIGRATIONS)
    const user = await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token: sessionToken } = await createSession({ db, userId: user.id })
    const { token: patToken } = await createPat({ db, userId: user.id, name: 'ci', scopes: [] })
    return { db, userId: user.id, sessionToken, patToken }
  }

  test('resolves the same row as the raw-token path', async () => {
    const { db, userId, sessionToken } = await seed()
    const byHash = await lookupActiveSessionByHash(db, hashToken(sessionToken))
    expect(byHash?.user.id).toBe(userId)
  })

  test('touch:false leaves last_used_at untouched (AC-8)', async () => {
    // The rescan runs once per live connection on EVERY revocation. Leaving the
    // rolling write in would turn one ACL edit into one write per open socket
    // and make /account report a credential as "just used" because a tab was
    // left open.
    const { db, sessionToken, patToken } = await seed()
    const sessionBefore = (await db.select().from(userSessions).limit(1))[0]
    const patBefore = (await db.select().from(userPats).limit(1))[0]

    await lookupActiveSessionByHash(db, hashToken(sessionToken), Date.now() + 60_000, {
      touch: false,
    })
    await lookupActivePatByHash(db, hashToken(patToken), Date.now() + 60_000, { touch: false })

    expect((await db.select().from(userSessions).limit(1))[0]?.lastUsedAt).toBe(
      sessionBefore?.lastUsedAt as number,
    )
    expect((await db.select().from(userPats).limit(1))[0]?.lastUsedAt).toBe(
      patBefore?.lastUsedAt as number,
    )
  })

  test('the default still touches — the HTTP path must not change', async () => {
    const { db, sessionToken } = await seed()
    const before = (await db.select().from(userSessions).limit(1))[0]?.lastUsedAt as number
    await lookupActiveSessionByHash(db, hashToken(sessionToken), before + 60_000)
    expect((await db.select().from(userSessions).limit(1))[0]?.lastUsedAt).toBe(before + 60_000)
  })

  test('a revoked or expired credential resolves to null on the read-only path too', async () => {
    const { db, sessionToken } = await seed()
    const hash = hashToken(sessionToken)
    expect(await lookupActiveSessionByHash(db, hash, Date.now(), { touch: false })).not.toBeNull()
    await db
      .update(userSessions)
      .set({ revokedAt: Date.now() })
      .where(eq(userSessions.tokenHash, hash))
    expect(await lookupActiveSessionByHash(db, hash, Date.now(), { touch: false })).toBeNull()
  })

  test('a disabled user resolves to null even with a live credential', async () => {
    const { db, userId, sessionToken } = await seed()
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, userId))
    expect(
      await lookupActiveSessionByHash(db, hashToken(sessionToken), Date.now(), { touch: false }),
    ).toBeNull()
  })
})

describe('RFC-212 T4 — every channel declares its revalidation strategy (AC-5)', () => {
  const kinds = Object.keys(WS_CHANNELS) as WsChannelKind[]

  test('the registry is non-empty and every kind is present', () => {
    expect(kinds.length).toBe(7)
    for (const kind of kinds) expect(WS_CHANNELS[kind].kind).toBe(kind)
  })

  test('each declaration is internally consistent with the channel it describes', () => {
    for (const kind of kinds) {
      const spec = WS_CHANNELS[kind]
      const r = spec.revalidation
      // refreshActor is what makes a demotion take effect anywhere; it is a
      // required literal so no channel can opt out.
      expect(`${kind}.refreshActor`).toBe(
        `${kind}.${String(r.refreshActor) === 'true' ? 'refreshActor' : 'MISSING'}`,
      )

      // A channel may only claim cache prefixes if it actually has a frameGate
      // that consults the cache — otherwise "cleared the cache" would masquerade
      // as "re-checked this channel".
      if (r.cache.kind === 'prefixes') {
        expect(`${kind}: has frameGate`).toBe(
          `${kind}: ${spec.frameGate !== undefined ? 'has frameGate' : 'NO frameGate'}`,
        )
        expect(r.cache.prefixes.length).toBeGreaterThan(0)
      } else {
        expect(`${kind}: why non-empty`).toBe(
          `${kind}: ${r.cache.why.length > 0 ? 'why non-empty' : 'EMPTY why'}`,
        )
      }

      // rerunUpgradeGate: true iff the channel actually has an upgradeGate.
      const hasGate = spec.upgradeGate !== undefined
      expect(`${kind}: rerun=${JSON.stringify(r.rerunUpgradeGate)} hasGate=${hasGate}`).toBe(
        `${kind}: rerun=${hasGate ? 'true' : JSON.stringify({ na: (r.rerunUpgradeGate as { na: string }).na })} hasGate=${hasGate}`,
      )
      if (!hasGate) {
        expect((r.rerunUpgradeGate as { na: string }).na.length).toBeGreaterThan(0)
      }
    }
  })

  test('the cache declarations match where ctx.cache is actually touched', () => {
    // The audit found the RFC's own first draft claiming memories /
    // scheduled-tasks had "a cache that never expires" — they have no cache at
    // all. Cross-check the declaration against the source rather than trusting
    // prose a second time.
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'ws', 'registry.ts'), 'utf8')
    const cachingChannels = kinds.filter(
      (k) => WS_CHANNELS[k].revalidation.cache.kind === 'prefixes',
    )
    expect(cachingChannels.sort()).toEqual(['tasks-list', 'workflows'])
    // `wf:` is the workflows prefix; the tasks-list cache is keyed by raw taskId.
    expect(src.includes('`wf:${')).toBe(true)
  })

  test('a channel spec without `revalidation` does not type-check', () => {
    // AC-5's teeth are at the TYPE level and `bun test` does not run tsc, so the
    // assertion has to be the compile error itself (same pattern as
    // rfc080-parametric-runtime-migration.test.ts). `Omit<…, 'revalidation'>` is
    // assignable to the spec type ONLY if the field is optional — so the moment
    // someone relaxes it, this directive becomes unused and `bun run typecheck`
    // fails with TS2578. Verified by mutation: making the field optional reds it.
    type Spec = (typeof WS_CHANNELS)['workflows']
    const withoutRevalidation = {} as Omit<Spec, 'revalidation'>
    // @ts-expect-error — `revalidation` is REQUIRED on ChannelSpec (RFC-212 AC-5)
    const incomplete: Spec = withoutRevalidation
    expect(incomplete).toBeDefined()
  })
})
