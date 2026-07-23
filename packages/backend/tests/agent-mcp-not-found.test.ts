// RFC-028 T5 — agent save-time guard: every `mcp[]` entry must exist in the
// mcps table at create / update time. Without this guard, agents save fine
// but the scheduler fails to load the missing mcp at runtime (or worse,
// silently drops it), turning "agent X needs mcp Y" into a non-actionable
// runtime mystery.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, updateAgent } from '../src/services/agent'
import { createMcp } from '../src/services/mcp'
import { ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function agentInput(name: string, mcp: string[] = []): Parameters<typeof createAgent>[1] {
  return {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp,
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  }
}

describe('agent.mcp save-time guard', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create succeeds when every mcp resolves (stored by id)', async () => {
    const m1 = await createMcp(db, {
      name: 'm1',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const a = await createAgent(db, agentInput('a', [m1.id]))
    expect(a.mcp).toEqual([m1.id])
  })

  test('create fails 422 mcp-not-found when an mcp is missing', async () => {
    let err: unknown
    try {
      await createAgent(db, agentInput('a', ['nope']))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    if (err instanceof ValidationError) {
      expect(err.code).toBe('mcp-not-found')
      expect((err.details as { notFound: string[] }).notFound).toEqual(['nope'])
    }
  })

  test('create reports ALL missing ids, not just the first', async () => {
    const present = await createMcp(db, {
      name: 'present',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    let err: unknown
    try {
      await createAgent(db, agentInput('a', [present.id, 'gone-1', 'gone-2']))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    if (err instanceof ValidationError) {
      expect((err.details as { notFound: string[] }).notFound.sort()).toEqual(['gone-1', 'gone-2'])
    }
  })

  test('update succeeds when patched mcp resolves (stored by id)', async () => {
    const m1 = await createMcp(db, {
      name: 'm1',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const agent = await createAgent(db, agentInput('a'))
    const updated = await updateAgent(db, agent.id, { mcp: [m1.id] })
    expect(updated.mcp).toEqual([m1.id])
  })

  test('update fails 422 mcp-not-found when a patched id is unknown', async () => {
    const agent = await createAgent(db, agentInput('a'))
    let err: unknown
    try {
      await updateAgent(db, agent.id, { mcp: ['nope'] })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    if (err instanceof ValidationError) {
      expect(err.code).toBe('mcp-not-found')
    }
  })

  test('update without `mcp` field skips the check (preserves existing)', async () => {
    const m1 = await createMcp(db, {
      name: 'm1',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const agent = await createAgent(db, agentInput('a', [m1.id]))
    // Now delete the mcp from the table by force (bypass the cascade guard so
    // we can construct the "stale ref" scenario without ref to other agents).
    // We simulate by manually clearing the row through the service: the guard
    // refuses, so use raw DB.
    const { mcps: mcpsTable } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(mcpsTable).where(eq(mcpsTable.id, m1.id))

    // PATCH something unrelated; should NOT trigger mcp validation, so it
    // passes even though the stale `mcp: [<id>]` is now unresolvable.
    const updated = await updateAgent(db, agent.id, { description: 'unrelated change' })
    expect(updated.description).toBe('unrelated change')
    expect(updated.mcp).toEqual([m1.id])
  })
})
