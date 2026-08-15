// RFC-304 T31b — the read side of `/code`, and the command that flips a cell.
//
// What these pin is the part a page cannot work around:
//
//   - a `misconfigured` cell arrives with the SPECIFIC missing piece and a
//     route that fixes it. A red label with no next step is the shape the
//     design names as the most common reason a platform like this is abandoned;
//   - the work-item list pages by CURSOR, because items are created while
//     somebody is scrolling and an offset silently skips or repeats rows;
//   - enabling a capability whose prerequisites are missing SAVES and reports
//     the resulting readiness, rather than pretending it is now running.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  capabilityBindings,
  capabilityFrameworks,
  codeRoundStages,
  codeWorkItems,
  codeWorkRounds,
  webhookEndpoints,
} from '../src/db/schema'
import {
  createCodeMatrixQuery,
  createCodeWorkItemProjectionQuery,
  deriveRoundStatus,
} from '../src/modules/code-capability/application/codeMatrixQuery'
import { createEnableCommand } from '../src/modules/code-capability/application/enableCommand'
import { repairActionsFor } from '../src/modules/code-capability/domain/repairActions'
import { upsertCapabilityCell } from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const REPO = 'group/project'
const ENDPOINT = 'ep-1'

const READY_FACTS = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

describe('RFC-304 — the capability matrix a page renders', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('a ready cell carries no issues and needs no repairs', async () => {
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: READY_FACTS,
      dependencyRevision: 1,
      now: NOW,
    })
    const [row] = await createCodeMatrixQuery(db).forRepo(REPO)
    expect(row?.readiness).toBe('ready')
    expect(row?.issues).toEqual([])
    expect(row?.repairActions).toEqual([])
  })

  test('a misconfigured cell pairs each issue with where to fix it', async () => {
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      bindingId: null,
      enabled: true,
      facts: { ...READY_FACTS, hasBinding: false, frameworkExists: false },
      dependencyRevision: 1,
      now: NOW,
    })
    const [row] = await createCodeMatrixQuery(db).forRepo(REPO)

    expect(row?.readiness).toBe('misconfigured')
    expect(row?.issues.length).toBeGreaterThan(0)
    // Positional pairing: the page renders issue[i] beside action[i].
    expect(row?.repairActions).toHaveLength(row?.issues.length ?? -1)
    expect(row?.repairActions.map((a) => a.code)).toEqual(row?.issues.map((i) => i.code))
    for (const action of row?.repairActions ?? []) {
      expect(action.route.startsWith('/')).toBe(true)
      expect(action.label.length).toBeGreaterThan(0)
    }
  })

  test('another repository’s cells are not returned', async () => {
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      bindingId: null,
      enabled: true,
      facts: READY_FACTS,
      dependencyRevision: 1,
      now: NOW,
    })
    expect(await createCodeMatrixQuery(db).forRepo('someone/else')).toEqual([])
  })

  test('every readiness code has a repair route', async () => {
    // A code with no route would render an issue nobody can act on. The mapping
    // is a `Record` of the union so this is enforced at build time too; this
    // asserts it at runtime for the codes that actually exist.
    const codes = [
      'no-binding',
      'no-trigger',
      'code-host-unconfigured',
      'agent-not-visible',
      'framework-missing',
      'no-wake-source',
    ] as const
    const actions = repairActionsFor(codes.map((code) => ({ code, detail: 'x' })))
    expect(actions).toHaveLength(codes.length)
    expect(actions.every((a) => a.route !== '' && a.label !== '')).toBe(true)
  })
})

describe('RFC-304 — the work-item projection', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  // A distinct anchor per item: the table's unique key is
  // (endpoint, project, capability, anchorKind, anchorId) — one work item per MR
  // per capability — so seeding two for the same MR is a fixture that could not
  // exist in production.
  const seedItem = async (id: string, createdAt: number, capability = 'mr-review') => {
    await db.insert(codeWorkItems).values({
      id,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: '41823',
      capability,
      anchorKind: 'mr',
      anchorId: `mr-${id}`,
      status: 'idle',
      epoch: 1,
      createdAt,
      updatedAt: createdAt,
    })
  }

  test('items come back newest first', async () => {
    await seedItem('item-old', NOW)
    await seedItem('item-new', NOW + 1000)
    const page = await createCodeWorkItemProjectionQuery(db).page({})
    expect(page.items.map((i) => i.workItemId)).toEqual(['item-new', 'item-old'])
  })

  test('a full page reports a cursor; the last page does not', async () => {
    // The distinction matters: claiming a next page that is empty makes an
    // infinite scroll spin forever on a list that has ended.
    await seedItem('a', NOW)
    await seedItem('b', NOW + 1)
    await seedItem('c', NOW + 2)

    const first = await createCodeWorkItemProjectionQuery(db).page({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await createCodeWorkItemProjectionQuery(db).page({
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((i) => i.workItemId)).toEqual(['a'])
    expect(second.nextCursor).toBeNull()
  })

  test('an exactly-full last page does not claim a next one', async () => {
    await seedItem('a', NOW)
    await seedItem('b', NOW + 1)
    const page = await createCodeWorkItemProjectionQuery(db).page({ limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  test('a stale cursor starts from the top rather than erroring', async () => {
    // A bookmarked link outliving its rows should render a list, not a failure.
    await seedItem('a', NOW)
    const page = await createCodeWorkItemProjectionQuery(db).page({ cursor: 'nonsense' })
    expect(page.items).toHaveLength(1)
  })

  test('the capability filter narrows the list', async () => {
    await seedItem('review', NOW, 'mr-review')
    await seedItem('monitor', NOW + 1, 'mr-monitor')
    const page = await createCodeWorkItemProjectionQuery(db).page({ capability: 'mr-review' })
    expect(page.items.map((i) => i.workItemId)).toEqual(['review'])
  })

  test('rounds and their stages are projected in reading order', async () => {
    await seedItem('item-1', NOW)
    await db.insert(codeWorkRounds).values({
      id: 'round-1',
      workItemId: 'item-1',
      roundSeq: 1,
      epoch: 1,
      outcome: 'published',
      startedAt: NOW,
      endedAt: NOW + 10,
    })
    await db.insert(codeRoundStages).values([
      {
        id: 's2',
        roundId: 'round-1',
        stageSeq: 1,
        stageName: 'prepare-worktree',
        stageKind: 'program',
        status: 'done',
      },
      {
        id: 's1',
        roundId: 'round-1',
        stageSeq: 0,
        stageName: 'resolve-target',
        stageKind: 'program',
        status: 'done',
      },
    ])

    const page = await createCodeWorkItemProjectionQuery(db).page({})
    const stages = page.items[0]?.rounds[0]?.stages ?? []
    // Ascending by sequence — the order the engine ran them, which is the
    // opposite of how rounds themselves are listed.
    expect(stages.map((s) => s.stageName)).toEqual(['resolve-target', 'prepare-worktree'])
  })
})

describe('RFC-304 — a round’s status is derived, not stored', () => {
  test('no outcome and no end time is running', async () => {
    expect(deriveRoundStatus(null, null)).toBe('running')
  })

  test('an outcome with an end time IS the outcome', async () => {
    expect(deriveRoundStatus('published', 1)).toBe('published')
  })

  test('an outcome with no end time is reported as settling, not smoothed away', async () => {
    // The window between recording the verdict and closing the row. A round
    // stuck there is a real symptom; calling it "running" would hide it.
    expect(deriveRoundStatus('published', null)).toBe('settling')
  })

  test('an end time with no outcome is named too', async () => {
    expect(deriveRoundStatus(null, 1)).toBe('ended-without-outcome')
  })
})

describe('RFC-304 — enabling a capability', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_enable',
      secretEnc: 'sealed',
      enabled: true,
    })
  })
  afterEach(() => db.$client.close())

  const command = () => createEnableCommand({ db, endpointId: ENDPOINT, now: () => NOW })

  test('a capability the platform does not ship is REFUSED, not saved', async () => {
    // Saving it would leave a row in the matrix forever, looking like a feature
    // that never runs.
    const result = await command().enable({
      repoId: REPO,
      capability: 'mr-invented',
      enabled: true,
      actorUserId: 'user-1',
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('unknown-capability')
  })

  test('enabling with prerequisites missing SAVES, and says what is still needed', async () => {
    // Configuring in whatever order suits you is legitimate. What must not
    // happen is a switch that reads "on" beside a capability that will never
    // run, with the person left to infer that from the silence.
    const result = await command().enable({
      repoId: REPO,
      capability: 'mr-review',
      enabled: true,
      actorUserId: 'user-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.row.enabled).toBe(true)
    expect(result.row.readiness).toBe('misconfigured')
    expect(result.row.repairActions.length).toBeGreaterThan(0)
  })

  test('a fully configured repository comes back READY', async () => {
    const agentId = 'agent-1'
    await db.insert(agents).values({
      id: agentId,
      name: 'reviewer-agent',
      bodyMd: 'x',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityFrameworks).values({
      id: 'fw-1',
      name: 'f',
      capability: 'mr-review',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityBindings).values({
      id: 'binding-1',
      name: 'b',
      frameworkId: 'fw-1',
      agentBySlotJson: JSON.stringify({ reviewer: agentId }),
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Saved twice on purpose — not because one is insufficient (see the
    // single-save test below), but because re-saving an already-ready cell must
    // be idempotent rather than knocking it back to misconfigured.
    await command().enable({
      repoId: REPO,
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
    })
    const result = await command().enable({
      repoId: REPO,
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.row.readiness).toBe('ready')
  })

  test('the trigger deadlock stays broken: ONE save reaches ready', async () => {
    // The bug (found 2026-08-16, fixed same day): readiness required a trigger,
    // and `enableCapability` armed one only for an already-ready cell. So a real
    // repository could never reach `ready` — save after save, forever
    // misconfigured with `no-trigger`. Every test passed `hasTrigger: true` by
    // hand, so nothing was red.
    //
    // Asserts ONE save, not two: the two-save version passes even with the
    // deadlock half-fixed, and "you have to press it twice" is exactly the
    // symptom a user would report.
    const agentId = 'agent-solo'
    await db.insert(agents).values({
      id: agentId,
      name: 'reviewer-agent',
      bodyMd: 'x',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityFrameworks).values({
      id: 'fw-solo',
      name: 'f',
      capability: 'mr-review',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityBindings).values({
      id: 'binding-solo',
      name: 'b',
      frameworkId: 'fw-solo',
      agentBySlotJson: JSON.stringify({ reviewer: agentId }),
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = await command().enable({
      repoId: 'solo/repo',
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-solo',
      actorUserId: 'user-1',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.row.readiness).toBe('ready')
    expect(result.ok && result.row.issues).toEqual([])
  })

  test('disabling reports DISABLED rather than misconfigured', async () => {
    const result = await command().enable({
      repoId: REPO,
      capability: 'mr-review',
      enabled: false,
      actorUserId: 'user-1',
    })
    expect(result.ok && result.row.readiness).toBe('disabled')
  })
})
