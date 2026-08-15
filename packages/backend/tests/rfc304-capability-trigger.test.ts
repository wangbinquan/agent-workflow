// RFC-304 §3.1 — the trigger that makes an enabled capability actually fire.
//
// A cell without its trigger is a capability that reads `ready` and never does
// anything; a trigger without its cell fires rounds for something the matrix
// says is off. Both are silent, so the two writes are done together and this
// file locks that they stay together in every direction:
//
//   enable ready      → cell + trigger
//   enable misconfig  → cell only, and any earlier trigger RETRACTED
//   disable           → trigger gone, cell disabled
//   toggle twice      → one row, not two firing the same round twice
//
// The last section is the product decision: these rows are visible in the
// trigger list (so "why did this MR start a task by itself" is answerable) but
// not editable or deletable there — deleting one would switch a capability off
// from a screen that never mentions capabilities.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { webhookEndpoints, webhookTriggers } from '../src/db/schema'
import { disableCapability, enableCapability } from '../src/services/codeCapabilityEnable'
import {
  assertTriggerIsUserOwned,
  findCapabilityTrigger,
} from '../src/services/codeCapabilityTrigger'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const ENDPOINT = 'ep-1'
const REPO = 'group/project'

const readyFacts = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

describe('RFC-304 — enabling a capability arms its trigger', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    // The trigger's endpoint_id is a real FK; without the row every insert
    // fails with SQLITE_CONSTRAINT_FOREIGNKEY rather than testing anything.
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'test endpoint',
      provider: 'gitlab',
      urlToken: 'tok',
      secretEnc: 'enc',
    })
  })
  afterEach(() => db.$client.close())

  const enable = (over: Record<string, unknown> = {}) =>
    enableCapability({
      db,
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
      ...over,
    } as never)

  test('a ready cell gets a trigger', async () => {
    const result = await enable()
    expect(result.cell.readiness).toBe('ready')
    expect(result.triggerId).not.toBeNull()

    const [row] = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.id, result.triggerId!))
    expect(row?.launchKind).toBe('code-round')
    expect(row?.launchRefId).toBe('mr-review')
    expect(JSON.parse(String(row?.launchPayload))).toEqual({ capability: 'mr-review' })
  })

  test('the trigger subscribes to the capability’s events', async () => {
    const result = await enable()
    const [row] = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.id, result.triggerId!))
    expect(JSON.parse(String(row?.eventTypes))).toEqual(['mr_opened', 'mr_updated'])
  })

  test('a cell that narrows its events narrows the trigger too', async () => {
    // Otherwise the row and the cell disagree about when this fires, and the
    // row is the one that actually decides.
    const result = await enable({ triggerConfig: { events: ['mr_updated'] } })
    const [row] = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.id, result.triggerId!))
    expect(JSON.parse(String(row?.eventTypes))).toEqual(['mr_updated'])
  })

  test('the trigger does not auto-register the event repository', async () => {
    // A round fetches the MR head itself, so registering the event repo would
    // clone something `prepare-worktree` immediately replaces.
    const result = await enable()
    const [row] = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.id, result.triggerId!))
    expect(row?.autoRegisterRepos).toBe(false)
  })

  test('it declares the v2 template syntax the round actually reads', async () => {
    // The round reads `trigger.webhook.*` from the frozen context; claiming the
    // historical flat shape would mis-describe a row written today.
    const result = await enable()
    const [row] = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.id, result.triggerId!))
    expect(row?.templateSyntaxVersion).toBe(2)
  })

  test('toggling twice leaves ONE trigger, not two', async () => {
    // Two rows would fire the same round twice per delivery — two reviews, two
    // sets of comments, on one MR.
    await enable()
    await enable()
    const rows = await db.select().from(webhookTriggers)
    expect(rows).toHaveLength(1)
  })
})

describe('RFC-304 — a capability that cannot run is not armed', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    // The trigger's endpoint_id is a real FK; without the row every insert
    // fails with SQLITE_CONSTRAINT_FOREIGNKEY rather than testing anything.
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'test endpoint',
      provider: 'gitlab',
      urlToken: 'tok',
      secretEnc: 'enc',
    })
  })
  afterEach(() => db.$client.close())

  const enable = (facts: Record<string, unknown>) =>
    enableCapability({
      db,
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

  test('a misconfigured cell writes NO trigger, and says why', async () => {
    const result = await enable({ ...readyFacts, codeHostConfigured: false })
    expect(result.triggerId).toBeNull()
    expect(result.triggerSkipped).toContain('misconfigured')
    expect(result.triggerSkipped).toContain('cannot be published')
    expect(await db.select().from(webhookTriggers)).toHaveLength(0)
  })

  test('a cell that BECOMES misconfigured has its trigger retracted', async () => {
    // The dangerous direction: a repo that was working, then lost its code-host
    // connection, must stop firing rather than keep firing with stale config.
    await enable(readyFacts)
    expect(await db.select().from(webhookTriggers)).toHaveLength(1)

    await enable({ ...readyFacts, hasBinding: false })
    expect(await db.select().from(webhookTriggers)).toHaveLength(0)
  })
})

describe('RFC-304 — disabling retracts the trigger', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    // The trigger's endpoint_id is a real FK; without the row every insert
    // fails with SQLITE_CONSTRAINT_FOREIGNKEY rather than testing anything.
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'test endpoint',
      provider: 'gitlab',
      urlToken: 'tok',
      secretEnc: 'enc',
    })
  })
  afterEach(() => db.$client.close())

  test('the trigger is gone and the cell is disabled', async () => {
    await enableCapability({
      db,
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

    const result = await disableCapability({
      db,
      endpointId: ENDPOINT,
      repoId: REPO,
      capability: 'mr-review',
      now: NOW + 1,
    })
    expect(result.triggerRetracted).toBe(true)
    expect(result.cell?.enabled).toBe(false)
    expect(await db.select().from(webhookTriggers)).toHaveLength(0)
  })

  test('the trigger is DELETED, not left disabled', async () => {
    // A disabled row in the trigger list is something a person can switch back
    // on — two switches for one behaviour, and they would disagree.
    await enableCapability({
      db,
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)
    await disableCapability({
      db,
      endpointId: ENDPOINT,
      repoId: REPO,
      capability: 'mr-review',
      now: NOW + 1,
    })
    expect(
      await findCapabilityTrigger(db, {
        endpointId: ENDPOINT,
        repoId: REPO,
        capability: 'mr-review',
      }),
    ).toBeNull()
  })

  test('disabling something that was never enabled is a no-op', async () => {
    const result = await disableCapability({
      db,
      endpointId: ENDPOINT,
      repoId: REPO,
      capability: 'mr-review',
      now: NOW,
    })
    expect(result.triggerRetracted).toBe(false)
    expect(result.cell).toBeNull()
  })
})

describe('RFC-304 — capability triggers are platform-owned (product decision ①)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    // The trigger's endpoint_id is a real FK; without the row every insert
    // fails with SQLITE_CONSTRAINT_FOREIGNKEY rather than testing anything.
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'test endpoint',
      provider: 'gitlab',
      urlToken: 'tok',
      secretEnc: 'enc',
    })
  })
  afterEach(() => db.$client.close())

  test('editing or deleting one is refused, naming where the switch really is', async () => {
    // Visible in the list — "why did this MR start a task by itself" has to be
    // answerable — but not editable there: deleting it would switch a
    // capability off from a screen that never mentions capabilities.
    const result = await enableCapability({
      db,
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoId: REPO,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

    let message = ''
    try {
      await assertTriggerIsUserOwned(db, result.triggerId!)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('mr-review')
    expect(message).toContain('capability configuration')
  })

  test('an ordinary trigger is untouched by the guard', async () => {
    // The guard must not make every trigger read-only.
    await db.insert(webhookTriggers).values({
      id: 'plain-1',
      name: 'a human trigger',
      endpointId: ENDPOINT,
      ownerUserId: 'user-1',
      repoScope: '{"kind":"any"}',
      eventTypes: '["push"]',
      launchKind: 'workflow',
      launchRefId: 'wf-1',
      launchPayload: '{}',
    })
    await assertTriggerIsUserOwned(db, 'plain-1')
  })
})
