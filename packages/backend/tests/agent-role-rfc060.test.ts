// RFC-060 PR-B — service-layer frontmatter round-trip for `role` and
// `outputWrapperPortNames`. Locks:
//
//  1. createAgent without role → stored fmExtra has no `role` key and the
//     returned Agent.role is undefined (treated as 'normal' by consumers).
//  2. createAgent with role: 'aggregator' → fmExtra.role persisted and
//     round-tripped back.
//  3. createAgent with role: 'normal' explicitly → still NOT persisted
//     (keeps fmExtra byte-identical to pre-RFC-060 agents).
//  4. updateAgent role: 'aggregator' → role lifted into fmExtra.
//  5. updateAgent role: 'normal' → role removed from fmExtra.
//  6. outputWrapperPortNames round-trips through frontmatter_extra.
//  7. outputKinds sidecar (RFC-005) and RFC-060 sidecars (role +
//     outputWrapperPortNames) coexist without trampling each other.
//  8. RFC-194: explicit empty sidecar maps survive update as `{}` tombstones.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { agents as agentsTable } from '../src/db/schema'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent, updateAgent } from '../src/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function basePayload(name: string) {
  return {
    name,
    description: '',
    outputs: ['report'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: { user_key: 'kept' },
    bodyMd: '',
  }
}

async function readFmExtraRaw(db: DbClient, name: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(agentsTable)
  const row = rows.find((r) => r.name === name)
  if (row === undefined) throw new Error(`no agent row '${name}'`)
  return JSON.parse(row.frontmatterExtra) as Record<string, unknown>
}

describe('RFC-060 PR-B — role round-trip', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createAgent without role → fmExtra has no role key; Agent.role undefined', async () => {
    const agent = await createAgent(db, basePayload('a'))
    expect(agent.role).toBeUndefined()
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).not.toHaveProperty('role')
    expect(fm).toEqual({ user_key: 'kept' })
  })

  test("createAgent with role: 'aggregator' persists into fmExtra + round-trips", async () => {
    const agent = await createAgent(db, { ...basePayload('a'), role: 'aggregator' })
    expect(agent.role).toBe('aggregator')
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm.role).toBe('aggregator')
    expect(fm.user_key).toBe('kept')

    const fetched = await getAgent(db, 'a')
    expect(fetched?.role).toBe('aggregator')
  })

  test("createAgent with role: 'normal' is NOT persisted (byte-equal to pre-RFC-060)", async () => {
    const agent = await createAgent(db, { ...basePayload('a'), role: 'normal' })
    expect(agent.role).toBeUndefined() // rowToAgent leaves it undefined
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).not.toHaveProperty('role')
  })

  test('updateAgent: normal → aggregator promotes role into fmExtra', async () => {
    await createAgent(db, basePayload('a'))
    const updated = await updateAgent(db, 'a', { role: 'aggregator' })
    expect(updated.role).toBe('aggregator')
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm.role).toBe('aggregator')
    // existing user-supplied key preserved
    expect(fm.user_key).toBe('kept')
  })

  test('updateAgent: aggregator → normal removes role from fmExtra', async () => {
    await createAgent(db, { ...basePayload('a'), role: 'aggregator' })
    const updated = await updateAgent(db, 'a', { role: 'normal' })
    expect(updated.role).toBeUndefined()
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).not.toHaveProperty('role')
    expect(fm.user_key).toBe('kept')
  })
})

describe('RFC-060 PR-B — outputWrapperPortNames round-trip', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createAgent with outputWrapperPortNames persists + round-trips', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })
    expect(agent.outputWrapperPortNames).toEqual({ report: 'final' })
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm.outputWrapperPortNames).toEqual({ report: 'final' })
  })

  test('updateAgent: add outputWrapperPortNames after create', async () => {
    await createAgent(db, basePayload('a'))
    const updated = await updateAgent(db, 'a', {
      outputWrapperPortNames: { report: 'r2' },
    })
    expect(updated.outputWrapperPortNames).toEqual({ report: 'r2' })
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm.outputWrapperPortNames).toEqual({ report: 'r2' })
  })

  test('without outputWrapperPortNames → field absent on Agent + fmExtra', async () => {
    const agent = await createAgent(db, basePayload('a'))
    expect(agent.outputWrapperPortNames).toBeUndefined()
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).not.toHaveProperty('outputWrapperPortNames')
  })
})

describe('RFC-060 PR-B — coexistence with RFC-005 outputKinds', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('outputKinds + role + outputWrapperPortNames + frontmatterExtra all round-trip', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      outputs: ['report', 'done'],
      outputKinds: { report: 'path<md>', done: 'signal' },
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })
    expect(agent.outputKinds).toEqual({ report: 'path<md>', done: 'signal' })
    expect(agent.role).toBe('aggregator')
    expect(agent.outputWrapperPortNames).toEqual({ report: 'final' })
    expect(agent.frontmatterExtra).toEqual({ user_key: 'kept' })

    // raw fmExtra has all three sidecars + user key, nothing else
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).toEqual({
      user_key: 'kept',
      outputKinds: { report: 'path<md>', done: 'signal' },
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })

    // exposed frontmatterExtra strips all 3 sidecars
    const fetched = await getAgent(db, 'a')
    expect(fetched?.frontmatterExtra).toEqual({ user_key: 'kept' })
  })

  test('patching role: aggregator does NOT clobber existing outputKinds', async () => {
    await createAgent(db, {
      ...basePayload('a'),
      outputs: ['report'],
      outputKinds: { report: 'path<md>' },
    })
    const updated = await updateAgent(db, 'a', { role: 'aggregator' })
    expect(updated.outputKinds).toEqual({ report: 'path<md>' })
    expect(updated.role).toBe('aggregator')

    const fm = await readFmExtraRaw(db, 'a')
    expect(fm.outputKinds).toEqual({ report: 'path<md>' })
    expect(fm.role).toBe('aggregator')
  })

  test('RFC-194: clearing both sidecar maps preserves empty tombstones and unrelated frontmatter', async () => {
    await createAgent(db, {
      ...basePayload('a'),
      outputs: ['report'],
      outputKinds: { report: 'path<md>' },
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })

    const updated = await updateAgent(db, 'a', {
      outputKinds: {},
      outputWrapperPortNames: {},
    })

    // The service response must distinguish an explicit clear (`{}`) from an
    // omitted sparse-patch field (`undefined`) while preserving adjacent data.
    expect(updated.outputKinds).toEqual({})
    expect(updated.outputWrapperPortNames).toEqual({})
    expect(updated.role).toBe('aggregator')
    expect(updated.frontmatterExtra).toEqual({ user_key: 'kept' })

    // The raw agent frontmatter is the persistence contract: both tombstones,
    // the reserved role, and unknown user-authored keys must all survive.
    const fm = await readFmExtraRaw(db, 'a')
    expect(fm).toEqual({
      user_key: 'kept',
      outputKinds: {},
      role: 'aggregator',
      outputWrapperPortNames: {},
    })
  })
})
