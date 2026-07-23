// RFC-166 — service-layer round-trip for the dedicated `agents.inputs` column.
//
// Unlike RFC-060's role/outputWrapperPortNames (which live in the
// frontmatter_extra sidecar), `inputs` is a first-class DB column symmetrical
// to `outputs`. Locks:
//
//  1. createAgent without inputs → column defaults to '[]'; Agent.inputs === [].
//  2. createAgent with declared inputs → JSON persisted in the column and
//     round-tripped back (kind default applied by the schema).
//  3. updateAgent replaces the inputs column wholesale (sparse-patch: absent
//     leaves it untouched, present overwrites).
//  4. inputs never leaks into frontmatter_extra (it is NOT a sidecar).
//  5. A malformed inputs column degrades to [] (parseInputsColumn guard).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { CreateAgent } from '@agent-workflow/shared'
import { agents as agentsTable } from '../src/db/schema'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent, updateAgent } from '../src/services/agent'

type CreateAgentInputs = CreateAgent['inputs']

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

async function readRawRow(db: DbClient, name: string) {
  const rows = await db.select().from(agentsTable).where(eq(agentsTable.name, name))
  const row = rows[0]
  if (row === undefined) throw new Error(`no agent row '${name}'`)
  return row
}

describe('RFC-166 — agents.inputs column round-trip', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createAgent without inputs → column [] and Agent.inputs === []', async () => {
    const agent = await createAgent(db, basePayload('a'))
    expect(agent.inputs).toEqual([])
    const row = await readRawRow(db, 'a')
    expect(row.inputs).toBe('[]')
    // not smuggled into fmExtra
    expect(JSON.parse(row.frontmatterExtra)).toEqual({ user_key: 'kept' })
  })

  test('createAgent with declared inputs persists + round-trips', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      inputs: [
        { name: 'diff', kind: 'string' },
        { name: 'spec', kind: 'markdown', required: true },
      ],
    })
    expect(agent.inputs).toEqual([
      { name: 'diff', kind: 'string' },
      { name: 'spec', kind: 'markdown', required: true },
    ])
    const row = await readRawRow(db, 'a')
    expect(JSON.parse(row.inputs)).toEqual([
      { name: 'diff', kind: 'string' },
      { name: 'spec', kind: 'markdown', required: true },
    ])
    // inputs is NOT a frontmatter_extra sidecar
    expect(JSON.parse(row.frontmatterExtra)).not.toHaveProperty('inputs')

    const fetched = await getAgent(db, 'a')
    expect(fetched?.inputs).toEqual([
      { name: 'diff', kind: 'string' },
      { name: 'spec', kind: 'markdown', required: true },
    ])
  })

  test('createAgent canonicalizes a raw partial input on write (kind default + strip)', async () => {
    // A caller that bypasses CreateAgentSchema's zod parse (e.g. hand-rolled
    // client / legacy payload) can hand createAgent an input port missing
    // `kind` and carrying an unknown key. serializeInputs re-parses so the
    // stored column is canonical: kind defaulted to 'string', junk stripped.
    const agent = await createAgent(db, {
      ...basePayload('a'),
      inputs: [{ name: 'diff', junk: 'x' }] as unknown as CreateAgentInputs,
    })
    expect(agent.inputs).toEqual([{ name: 'diff', kind: 'string' }])
    const row = await readRawRow(db, 'a')
    expect(JSON.parse(row.inputs)).toEqual([{ name: 'diff', kind: 'string' }])
  })

  test('updateAgent replaces inputs wholesale', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      inputs: [{ name: 'diff', kind: 'string' }],
    })
    const updated = await updateAgent(db, agent.id, {
      inputs: [{ name: 'spec', kind: 'markdown' }],
    })
    expect(updated.inputs).toEqual([{ name: 'spec', kind: 'markdown' }])
    const row = await readRawRow(db, 'a')
    expect(JSON.parse(row.inputs)).toEqual([{ name: 'spec', kind: 'markdown' }])
  })

  test('updateAgent without inputs leaves the column untouched', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      inputs: [{ name: 'diff', kind: 'string' }],
    })
    const updated = await updateAgent(db, agent.id, { description: 'changed' })
    expect(updated.inputs).toEqual([{ name: 'diff', kind: 'string' }])
  })

  test('updateAgent can clear inputs to []', async () => {
    const agent = await createAgent(db, {
      ...basePayload('a'),
      inputs: [{ name: 'diff', kind: 'string' }],
    })
    const updated = await updateAgent(db, agent.id, { inputs: [] })
    expect(updated.inputs).toEqual([])
    const row = await readRawRow(db, 'a')
    expect(row.inputs).toBe('[]')
  })

  test('malformed inputs column degrades to [] (parse guard)', async () => {
    await createAgent(db, basePayload('a'))
    // corrupt the column out-of-band
    await db.update(agentsTable).set({ inputs: 'not json' }).where(eq(agentsTable.name, 'a'))
    const fetched = await getAgent(db, 'a')
    expect(fetched?.inputs).toEqual([])
  })

  test('serializeInputs rejects duplicate port names on write (Codex PR-1 P2)', async () => {
    // Persistence-layer guard: even a service caller that bypassed the route's
    // CreateAgentSchema validation cannot persist duplicate input port names.
    await expect(
      createAgent(db, {
        ...basePayload('a'),
        inputs: [
          { name: 'spec' },
          { name: 'spec', kind: 'markdown' },
        ] as unknown as CreateAgentInputs,
      }),
    ).rejects.toThrow()
    // nothing was written (create threw before/at the insert)
    const rows = await db.select().from(agentsTable).where(eq(agentsTable.name, 'a'))
    expect(rows.length).toBe(0)
  })
})
