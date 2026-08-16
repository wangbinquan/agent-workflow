// RFC-304 §11.3 (T61) — "review stopped working here" has an answer.
//
// The three things an administrator can check today all fail to distinguish the
// cases, and each case has a DIFFERENT fix:
//
//   `readiness = ready`  — the config is complete. Says nothing about whether
//                          anything ran.
//   last trigger time    — nothing arrived. Cannot separate "the hook was never
//                          sent" from "it arrived and routing dropped it" from
//                          "it is queued behind a merge-request lease".
//   "send a test event"  — proves the test path works, if it shortcuts the real
//                          one.
//
// So the chain records the step reached AND the reason. A row saying "dropped"
// with no reason has moved the question rather than answered it, which is why
// most of these tests are about the reason rather than the step.
//
// The other load-bearing distinction: `dropped` is NOT `failed`. A healthy
// platform drops most deliveries — every webhook for a repository nobody
// registered — and painting those red trains an administrator to ignore the
// colour that means something is broken.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { repoCapabilityConfig, webhookDeliveries } from '../src/db/schema'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  DELIVERY_STEPS,
  describeDelivery,
  describeQueue,
  needsAttention,
  stepIndex,
} from '../src/modules/code-capability/domain/deliveryChain'
import {
  advanceDelivery,
  deliveriesByCorrelation,
  failedDeliveries,
  openDelivery,
  recentDeliveries,
} from '../src/modules/code-capability/infrastructure/sqliteDeliveryChain'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

describe('RFC-304 T61 — the step vocabulary', () => {
  test('the steps are ordered, because “where did it stop” needs a sequence', () => {
    // The reader's next question after "it stopped at X" is always "and what
    // comes after X". An unordered set cannot answer it.
    expect(stepIndex('received')).toBeLessThan(stepIndex('matched'))
    expect(stepIndex('matched')).toBeLessThan(stepIndex('routed'))
    expect(stepIndex('routed')).toBeLessThan(stepIndex('queued'))
    expect(stepIndex('queued')).toBeLessThan(stepIndex('round'))
    expect(stepIndex('round')).toBeLessThan(stepIndex('published'))
    expect(DELIVERY_STEPS).toHaveLength(6)
  })

  test('an in-flight delivery says what it is waiting for', () => {
    const text = describeDelivery({ kind: 'ok', step: 'routed' })
    expect(text).toContain('routed')
    expect(text).toContain('queued')
  })

  test('a dropped delivery reads as a DECISION, not a fault', () => {
    // Most deliveries are dropped. If that reads as an error, the one that is
    // an error stops standing out — which is the whole failure mode here.
    const text = describeDelivery({
      kind: 'dropped',
      step: 'matched',
      reason: 'no registered repository matches this event',
    })
    expect(text).toContain('on purpose')
    expect(text).toContain('no registered repository')
    expect(needsAttention({ kind: 'dropped', step: 'matched', reason: 'x' })).toBe(false)
  })

  test('a failed delivery is the one that needs somebody', () => {
    expect(needsAttention({ kind: 'failed', step: 'round', reason: 'x' })).toBe(true)
  })

  test('a queued line carries age AND position', () => {
    // "Queued" alone is indistinguishable from "stuck", and an administrator
    // who cannot tell them apart restarts the daemon — which discards the queue
    // and turns a wait into a loss.
    const text = describeQueue({ ageMs: 5 * 60_000, position: 3, waitingOn: 'mr-lease' })
    expect(text).toContain('5 minutes')
    expect(text).toContain('position 3')
    expect(text).toContain('merge request')
  })

  test('a fresh queue entry does not claim “0 minutes”', () => {
    // Rounding to zero reads as "no time has passed", which is the same thing
    // an absent value looks like.
    expect(describeQueue({ ageMs: 900, position: null, waitingOn: 'global-quota' })).toContain(
      'less than a minute',
    )
  })
})

describe('RFC-304 T61 — the record', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const open = async (over: Partial<Parameters<typeof openDelivery>[0]> = {}) =>
    await openDelivery({
      db,
      correlationId: 'corr-1',
      stableProjectId: '41823',
      codeHostEndpointId: 'ep-1',
      now: NOW,
      ...over,
    })

  test('a delivery is ONE row advanced in place, not a row per step', async () => {
    // A step-per-row table makes "what is stuck right now" a group-by over the
    // whole history — the query an administrator runs when something is wrong
    // would be the slowest one.
    const { id } = await open()
    await advanceDelivery({ db, deliveryId: id, step: 'matched', outcome: 'ok', now: NOW + 1 })
    await advanceDelivery({
      db,
      deliveryId: id,
      step: 'round',
      outcome: 'ok',
      capability: 'mr-review',
      roundId: 'round-1',
      now: NOW + 2,
    })

    const rows = await recentDeliveries({ db, stableProjectId: '41823' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.step).toBe('round')
    expect(rows[0]?.capability).toBe('mr-review')
    expect(rows[0]?.roundId).toBe('round-1')
  })

  test('leaving the queue clears the queue detail', async () => {
    // Otherwise a delivered row still advertises the position it waited in,
    // and a reader scanning for what is stuck finds something that is not.
    const { id } = await open()
    await advanceDelivery({
      db,
      deliveryId: id,
      step: 'queued',
      outcome: 'ok',
      queue: { ageMs: 60_000, position: 2, waitingOn: 'mr-lease' },
      now: NOW + 1,
    })
    let rows = await recentDeliveries({ db, stableProjectId: '41823' })
    expect(rows[0]?.queuePosition).toBe(2)
    expect(rows[0]?.waitingOn).toBe('mr-lease')

    await advanceDelivery({ db, deliveryId: id, step: 'round', outcome: 'ok', now: NOW + 2 })
    rows = await recentDeliveries({ db, stableProjectId: '41823' })
    expect(rows[0]?.queuePosition).toBeNull()
    expect(rows[0]?.waitingOn).toBeNull()
  })

  test('the failure list contains failures and NOT drops', async () => {
    // The list an administrator opens when something is wrong. Including drops
    // would bury the one real problem under the ordinary traffic.
    const dropped = await open()
    await advanceDelivery({
      db,
      deliveryId: dropped.id,
      step: 'matched',
      outcome: 'dropped',
      reason: 'no registered repository',
      now: NOW + 1,
    })
    const failed = await open({ correlationId: 'corr-2' })
    await advanceDelivery({
      db,
      deliveryId: failed.id,
      step: 'routed',
      outcome: 'failed',
      reason: 'the binding was deleted',
      now: NOW + 2,
    })

    const rows = await failedDeliveries({ db, stableProjectId: '41823' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reason).toBe('the binding was deleted')
  })

  test('a correlation id ties the story together across tables', async () => {
    // Without it the chain reconstructs by timestamp proximity, which is wrong
    // exactly when the platform is busy — the moment somebody is debugging it.
    await open({ correlationId: 'corr-shared' })
    await open({ correlationId: 'corr-shared', stableProjectId: 'other' })
    await open({ correlationId: 'corr-unrelated' })

    expect(await deliveriesByCorrelation({ db, correlationId: 'corr-shared' })).toHaveLength(2)
  })

  test('a probe is marked, and still walks the same path', async () => {
    // The flag exists so the list can separate probes from real traffic — never
    // so the code can take a shortcut for them. A test event that skipped the
    // real path would prove only that the shortcut works.
    const { id } = await open({ isProbe: true })
    await advanceDelivery({ db, deliveryId: id, step: 'matched', outcome: 'ok', now: NOW + 1 })

    const rows = await recentDeliveries({ db, stableProjectId: '41823' })
    expect(rows[0]?.isProbe).toBe(true)
    expect(rows[0]?.step).toBe('matched')
  })

  test('a retried delivery moves forward rather than staying failed', async () => {
    // Refusing the write once terminal would leave the row claiming a failure
    // that no longer describes it.
    const { id } = await open()
    await advanceDelivery({
      db,
      deliveryId: id,
      step: 'routed',
      outcome: 'failed',
      reason: 'transient',
      now: NOW + 1,
    })
    await advanceDelivery({ db, deliveryId: id, step: 'round', outcome: 'ok', now: NOW + 2 })

    const rows = await recentDeliveries({ db, stableProjectId: '41823' })
    expect(rows[0]?.outcome).toBe('ok')
    expect(rows[0]?.reason).toBeNull()
  })
})

// The join. Everything above tests the record; this tests that the record is
// made by the REAL dispatcher rather than by a parallel bookkeeping nobody
// calls — the pattern that has repeated through this RFC and never goes red on
// its own, because an absent mechanism raises no error.
describe('RFC-304 T61 — the chain records real dispatch', () => {
  const ENDPOINT = 'ep-1'
  const REPO_ID = 'repo-1'
  const PROJECT = '41823'
  let db: DbClient
  let deps: Parameters<typeof createWebhookDispatcher>[0]
  let home: string

  const endpoint = {
    id: ENDPOINT,
    provider: 'gitlab' as const,
    name: 'ep',
    secretEnc: '',
    urlToken: 'tok',
    enabled: true,
    preferredCloneProtocol: 'http' as const,
    lastDeliveryAt: null,
    createdAt: 1,
    updatedAt: 1,
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-chain-'))
    await seedTestDefaultOpencodeRuntime(db)
    deps = {
      db,
      configPath: join(home, 'config.json'),
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 7)),
      getDefaultRuntime: async () => null,
      resolveRepo: async () => ({ kind: 'cached', cachedRepoId: REPO_ID }),
      launch: async () => ulid(),
      cancel: async () => undefined,
    } as unknown as Parameters<typeof createWebhookDispatcher>[0]

    await db.insert(repoCapabilityConfig).values({
      id: ulid(),
      repoId: REPO_ID,
      capability: 'mr-review',
      enabled: true,
      readiness: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  const deliver = async (over: Partial<CodeHostEvent> = {}): Promise<string> => {
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: ENDPOINT,
      eventType: 'merge_request',
      status: 'received',
      receivedAt: NOW,
    })
    await createWebhookDispatcher(deps).dispatch({
      deliveryId,
      endpoint,
      event: {
        eventType: 'merge_request',
        provider: 'gitlab',
        projectId: PROJECT,
        mrIid: '412',
        author: {},
        eventUuid: null,
        ...over,
      } as unknown as CodeHostEvent,
    })
    return deliveryId
  }

  test('a real delivery leaves a chain row carrying the correlation id', async () => {
    const deliveryId = await deliver()
    const rows = await deliveriesByCorrelation({ db, correlationId: deliveryId })
    expect(rows.length).toBeGreaterThan(0)
    expect(DELIVERY_STEPS).toContain(rows[0]!.step)
  })

  test('a wake that CRASHES is recorded as failed, not left claiming ok', async () => {
    // Found by this file's own log output: the first wiring opened the row and
    // returned from the catch without touching it, so a crashed delivery sat at
    // `received / ok`. That is worse than no row — it actively tells an
    // administrator the delivery was fine, which is the misreading the whole
    // table exists to prevent.
    const boom = {
      ...deps,
      resolveRepo: async () => {
        throw new Error('resolver exploded')
      },
    }
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: ENDPOINT,
      eventType: 'merge_request',
      status: 'received',
      receivedAt: NOW,
    })
    await createWebhookDispatcher(
      boom as unknown as Parameters<typeof createWebhookDispatcher>[0],
    ).dispatch({
      deliveryId,
      endpoint,
      event: {
        eventType: 'merge_request',
        provider: 'gitlab',
        projectId: PROJECT,
        mrIid: '412',
        author: {},
        eventUuid: null,
      } as unknown as CodeHostEvent,
    })

    const rows = await deliveriesByCorrelation({ db, correlationId: deliveryId })
    expect(rows[0]?.outcome).toBe('failed')
    expect(rows[0]?.reason).toContain('resolver exploded')
  })

  test('a deployment with NO enabled capability writes no chain row', async () => {
    // Cost control, and deliberate: a deployment that has configured nothing is
    // not troubleshooting capability delivery, and one row per webhook there is
    // pure overhead. Also keeps the RFC-268 guarantee intact — that path
    // returns before the repo resolver.
    await db.delete(repoCapabilityConfig)
    const deliveryId = await deliver()
    expect(await deliveriesByCorrelation({ db, correlationId: deliveryId })).toEqual([])
  })
})
