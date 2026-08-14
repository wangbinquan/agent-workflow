// RFC-294 P0-B/W6 pre-refactor characterization.
//
// Intent Apply and BundleApply are still separate engines.  These tests lock
// the user-visible lifecycle they must both preserve while W6 moves new
// admissions behind one AtomicApplyEngine: fresh work is not reaped, stale
// crash residue converges once, failed attempts never re-execute, and a
// committed receipt remains replayable after mutable surrounding state moves.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'

import { buildActor, type Actor } from '@/auth/actor'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { agents, intentApplyJournal, intentSessions, resourceBundleApplies } from '@/db/schema'
import {
  applyIntentChangeset,
  convergeIntentApplyJournal,
  type IntentApplyReceipt,
} from '@/services/intent/applyChangeset'
import { applyResourceBundle, convergeResourceBundleApplies } from '@/services/bundle/apply'
import type { BundleApplyProvider, BundleReceipt } from '@/services/bundle/provider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const OWNER_ID = 'rfc294-apply-owner'

let db: DbClient
let appHome: string
let sessionId: string

function actorOf(id: string): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

function emptyBundle(): ResourceBundle {
  return { bundleVersion: 1, ops: [] }
}

function provider(scope: string, key: string, actor: Actor = actorOf(OWNER_ID)) {
  return {
    idempotencyKey: { scope, key },
    serializationKey: `serialization:${scope}:${key}`,
    actor,
    resolveExternal: async (ref: string) => ref,
    readSkillFile: () => new Uint8Array(),
  } satisfies BundleApplyProvider
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc294-apply-parity-'))
  sessionId = ulid()
  const now = Date.now()
  await db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER_ID,
    title: 'RFC-294 apply parity',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
})

afterEach(() => {
  db.$client.close()
  rmSync(appHome, { recursive: true, force: true })
})

interface PairIds {
  intentId: string
  intentKey: string
  bundleId: string
  bundleScope: string
  bundleKey: string
}

async function seedPair(
  suffix: string,
  state: 'prepared' | 'applying' | 'committed' | 'failed',
  updatedAt: number,
  receipts?: { intent: IntentApplyReceipt; bundle: BundleReceipt },
): Promise<PairIds> {
  const intentId = ulid()
  const intentKey = `intent-${suffix}`
  const bundleId = ulid()
  const bundleScope = `package-${suffix}`
  const bundleKey = `bundle-${suffix}`
  await db.insert(intentApplyJournal).values({
    id: intentId,
    sessionId,
    clientMutationId: intentKey,
    draftId: `draft-${suffix}`,
    draftHash: `sha256:${suffix}`,
    state,
    preparedArtifactsJson: '[]',
    receiptJson: receipts === undefined ? null : JSON.stringify(receipts.intent),
    error: state === 'failed' ? 'seeded failure' : null,
    createdAt: updatedAt,
    updatedAt,
  })
  await db.insert(resourceBundleApplies).values({
    id: bundleId,
    scope: bundleScope,
    key: bundleKey,
    actorUserId: OWNER_ID,
    state,
    preparedArtifactsJson: '[]',
    receiptJson: receipts === undefined ? null : JSON.stringify(receipts.bundle),
    error: state === 'failed' ? 'seeded failure' : null,
    createdAt: updatedAt,
    updatedAt,
  })
  return { intentId, intentKey, bundleId, bundleScope, bundleKey }
}

async function intentState(id: string) {
  return db.select().from(intentApplyJournal).where(eq(intentApplyJournal.id, id)).get()
}

async function bundleState(id: string) {
  return db.select().from(resourceBundleApplies).where(eq(resourceBundleApplies.id, id)).get()
}

describe('RFC-294 AtomicApply migration parity', () => {
  test('fresh work survives a sweep; after restart-age it converges failed and replay stays side-effect free', async () => {
    const pair = await seedPair('crash', 'applying', Date.now())

    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(await convergeResourceBundleApplies(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect((await intentState(pair.intentId))?.state).toBe('applying')
    expect((await bundleState(pair.bundleId))?.state).toBe('applying')

    const stale = Date.now() - 11 * 60 * 1000
    await db
      .update(intentApplyJournal)
      .set({ updatedAt: stale })
      .where(eq(intentApplyJournal.id, pair.intentId))
    await db
      .update(resourceBundleApplies)
      .set({ updatedAt: stale })
      .where(eq(resourceBundleApplies.id, pair.bundleId))

    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect(await convergeResourceBundleApplies(db, appHome)).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect((await intentState(pair.intentId))?.state).toBe('failed')
    expect((await bundleState(pair.bundleId))?.state).toBe('failed')

    await expect(
      applyIntentChangeset(
        { db, appHome, actor: actorOf(OWNER_ID) },
        {
          sessionId,
          clientMutationId: pair.intentKey,
          draftRevision: 1,
          draftHash: 'sha256:crash',
          decisions: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'intent-apply-failed-replay' })
    await expect(
      applyResourceBundle(
        { db, appHome },
        {
          bundle: emptyBundle(),
          provider: provider(pair.bundleScope, pair.bundleKey),
        },
      ),
    ).rejects.toMatchObject({ code: 'bundle-apply-failed-replay' })

    expect(await db.select().from(agents)).toEqual([])
    expect(await db.select().from(intentApplyJournal)).toHaveLength(1)
    expect(await db.select().from(resourceBundleApplies)).toHaveLength(1)
  })

  test('committed receipts replay exactly even after mutable admission state changes', async () => {
    const intentReceipt: IntentApplyReceipt = {
      journalId: 'intent-receipt',
      commitSeq: 7,
      applied: [],
    }
    const bundleReceipt: BundleReceipt = { journalId: 'bundle-receipt', applied: [] }
    const pair = await seedPair('committed', 'committed', Date.now(), {
      intent: intentReceipt,
      bundle: bundleReceipt,
    })

    // A byte-identical successful request may be retried after the UI archived
    // its Intent session or after a package preview expired. Duplicate lookup
    // must win over those mutable validations; actor/request mismatches are a
    // separate P0/W6 blocker and are deliberately not characterized as green.
    await db
      .update(intentSessions)
      .set({ status: 'archived', inFlightTurnId: ulid() })
      .where(eq(intentSessions.id, sessionId))

    const intentReplay = await applyIntentChangeset(
      { db, appHome, actor: actorOf(OWNER_ID) },
      {
        sessionId,
        clientMutationId: pair.intentKey,
        draftRevision: 1,
        draftHash: 'sha256:committed',
        decisions: [],
      },
    )
    const bundleReplay = await applyResourceBundle(
      { db, appHome },
      {
        bundle: emptyBundle(),
        provider: {
          ...provider(pair.bundleScope, pair.bundleKey),
          claimInTx: () => {
            throw new Error('mutable admission validation must not run on committed replay')
          },
        },
      },
    )

    expect(intentReplay).toEqual(intentReceipt)
    expect(bundleReplay).toEqual(bundleReceipt)
    expect((await intentState(pair.intentId))?.state).toBe('committed')
    expect((await bundleState(pair.bundleId))?.state).toBe('committed')
  })

  test('Intent replay remains owner-scoped and does not reveal another user receipt', async () => {
    const intentReceipt: IntentApplyReceipt = {
      journalId: 'private-intent-receipt',
      commitSeq: 1,
      applied: [],
    }
    const pair = await seedPair('private', 'committed', Date.now(), {
      intent: intentReceipt,
      bundle: { journalId: 'unused-bundle-receipt', applied: [] },
    })

    await expect(
      applyIntentChangeset(
        { db, appHome, actor: actorOf('rfc294-other-user') },
        {
          sessionId,
          clientMutationId: pair.intentKey,
          draftRevision: 1,
          draftHash: 'sha256:private',
          decisions: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'intent-session-not-found' })
    expect((await intentState(pair.intentId))?.receiptJson).toBe(JSON.stringify(intentReceipt))
  })
})
