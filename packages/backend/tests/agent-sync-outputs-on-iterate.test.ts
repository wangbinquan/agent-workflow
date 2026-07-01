// RFC-014 T0 — verifies the `syncOutputsOnIterate` agent field round-trips
// through createAgent / updateAgent / getAgent, defaults to true when not
// supplied (zod default applied at the route boundary; tests at this layer
// pass the field explicitly to match the inferred CreateAgent type), and
// that an opt-out (false) persists.
//
// The "migration backfill" half of A8b is covered implicitly: createInMemoryDb
// runs the bundled migration 0004 which adds the column with DEFAULT 1; any
// pre-migration row would inherit `1` (true). We can't realistically simulate
// "row inserted before migration 0004" in an in-memory DB that already has
// the column, so the column default itself is the contract.
//
// C5 regression lock (RFC-014 §4): if anyone removes the column or downgrades
// the default to false, the "syncOutputsOnIterate default true" case breaks.

import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryDb } from '../src/db/client'
import { agents } from '../src/db/schema'
import { createAgent, getAgent, updateAgent } from '../src/services/agent'
import type { DbClient } from '../src/db/client'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('agent.syncOutputsOnIterate (RFC-014 T0)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('createAgent persists syncOutputsOnIterate=true', async () => {
    const a = await createAgent(db, {
      name: 'designer-on',
      description: '',
      outputs: ['proposal', 'design'],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(a.syncOutputsOnIterate).toBe(true)
    const reread = await getAgent(db, 'designer-on')
    expect(reread?.syncOutputsOnIterate).toBe(true)
  })

  test('createAgent opt-out syncOutputsOnIterate=false persists', async () => {
    const a = await createAgent(db, {
      name: 'designer-off',
      description: '',
      outputs: ['proposal', 'design'],
      syncOutputsOnIterate: false,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(a.syncOutputsOnIterate).toBe(false)
    const reread = await getAgent(db, 'designer-off')
    expect(reread?.syncOutputsOnIterate).toBe(false)
  })

  test('updateAgent flips syncOutputsOnIterate; other fields preserved', async () => {
    await createAgent(db, {
      name: 'designer',
      description: 'orig',
      outputs: ['x'],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'body',
    })
    const updated = await updateAgent(db, 'designer', { syncOutputsOnIterate: false })
    expect(updated.syncOutputsOnIterate).toBe(false)
    expect(updated.description).toBe('orig')
    expect(updated.outputs).toEqual(['x'])
  })

  test('raw insert without syncOutputsOnIterate inherits column DEFAULT (true)', async () => {
    // Simulates an older agent row written by code that predates RFC-014 —
    // drizzle column-level DEFAULT (1) supplies the value, rowToAgent surfaces
    // it as true. This is the load-bearing assertion for the A8b
    // migration-backfill contract.
    const id = ulid()
    // Intentionally omit syncOutputsOnIterate to exercise the column DEFAULT.
    const row: typeof agents.$inferInsert = {
      id,
      name: 'legacy',
      outputs: '["a"]',
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: 0,
      updatedAt: 0,
    } as typeof agents.$inferInsert
    await db.insert(agents).values(row)
    const got = await getAgent(db, 'legacy')
    expect(got?.syncOutputsOnIterate).toBe(true)
  })
})
