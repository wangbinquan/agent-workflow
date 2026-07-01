// Locks RFC-022 §2.1 #5 / verifies design.md §3.2 (validateDependsOn).
//
// Save-time guard for agent.dependsOn. Red here means one of the four refusal
// branches drifted:
//   1. unknown name              → agent-dependency-not-found
//   2. self-reference            → agent-dependency-self
//   3. closure cycle             → agent-dependency-cycle (cyclePath shape)
//   4. de-dup preserves order    → input ["a","b","a","c"] survives as ["a","b","c"]
//                                   and validation accepts it
//
// The BFS itself is exercised end-to-end via these guards (path tracking,
// cycle slicing) — a separate scheduler-depends-closure.test.ts covers the
// "happy path with closure ordering" case that's not visible from the save
// guard alone.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import {
  findAgentsDependingOn,
  resolveDependsClosure,
  validateDependsOn,
} from '../src/services/agentDeps'
import type { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface AgentSeed {
  name: string
  dependsOn?: string[]
  mcp?: string[]
}

async function seed(db: DbClient, ...rows: AgentSeed[]): Promise<void> {
  for (const r of rows) {
    await createAgent(db, {
      name: r.name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: r.dependsOn ?? [],
      mcp: r.mcp ?? [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
  }
}

describe('RFC-022 validateDependsOn (save-time guard)', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('rejects unknown dependsOn name', async () => {
    await seed(db, { name: 'orchestrator' })
    await expect(validateDependsOn(db, 'orchestrator', ['no-such-agent'])).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
      details: { notFound: ['no-such-agent'] },
    })
  })

  test('rejects self-reference (even for not-yet-persisted new agent)', async () => {
    // New-agent flow: 'fresh' does not exist in DB yet. Self-ref still caught.
    await expect(validateDependsOn(db, 'fresh', ['fresh'])).rejects.toMatchObject({
      code: 'agent-dependency-self',
      details: { name: 'fresh' },
    })
  })

  test('rejects cycle and reports just the loop in cyclePath (not the full prefix)', async () => {
    // Seed leaves first so createAgent's save-time guard accepts each row:
    // c → (nothing), b → c, a → b. Now attempt to put c.dependsOn = ['a'],
    // which would close the loop A → B → C → A. validateDependsOn runs on
    // the *proposed* row (c), so we ask for selfName='c'.
    await seed(db, { name: 'c' })
    await seed(db, { name: 'b', dependsOn: ['c'] })
    await seed(db, { name: 'a', dependsOn: ['b'] })
    await expect(validateDependsOn(db, 'c', ['a'])).rejects.toMatchObject({
      code: 'agent-dependency-cycle',
    })
    try {
      await validateDependsOn(db, 'c', ['a'])
    } catch (e) {
      const err = e as DomainError
      // The loop is "c → a → b → c"; the BFS root is the synthetic 'c' so
      // the path starts with 'c'. Anything that does NOT include the full
      // round-trip is a regression.
      const path = (err.details as { cyclePath: string[] }).cyclePath
      expect(path[0]).toBe('c')
      expect(path[path.length - 1]).toBe('c')
      expect(path).toContain('a')
      expect(path).toContain('b')
    }
  })

  test('accepts a valid diamond (A → B,C ; B → D ; C → D) and dedupes input', async () => {
    // Diamond convergence on D is legal — not a cycle. validateDependsOn
    // should accept and silently dedupe duplicate names in the input.
    // Seed leaf D first so createAgent's save-time guard accepts B and C.
    await seed(db, { name: 'd' })
    await seed(db, { name: 'b', dependsOn: ['d'] })
    await seed(db, { name: 'c', dependsOn: ['d'] })
    await expect(validateDependsOn(db, 'a', ['b', 'c', 'b', 'd', 'c'])).resolves.toBeUndefined()
  })

  test('resolveDependsClosure: happy path returns BFS order with root first; allowMissing skips dangling', async () => {
    // Leaves first, then parents — createAgent's RFC-022 save-time guard
    // requires that every dependsOn name resolves at insertion time. The
    // "ghost" reference is injected post-hoc via a raw UPDATE so the guard
    // doesn't trip on the missing name during seeding.
    await seed(db, { name: 'leaf' })
    await seed(db, { name: 'mid', dependsOn: ['leaf'] })
    await seed(db, { name: 'top', dependsOn: ['mid'] })
    const { sql } = await import('drizzle-orm')
    await db.run(sql`UPDATE agents SET depends_on = '["mid","ghost"]' WHERE name = 'top'`)
    const top = await (await import('../src/services/agent')).getAgent(db, 'top')
    expect(top).not.toBeNull()
    if (top === null) throw new Error('unreachable')

    // Default: throws on missing
    await expect(resolveDependsClosure(db, top)).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
    })

    // allowMissing: missing 'ghost' silently skipped, traversal continues
    const closure = await resolveDependsClosure(db, top, { allowMissing: true })
    expect(closure.ok).toBe(true)
    if (closure.ok === false) throw new Error('unreachable')
    expect(closure.agents.map((a) => a.name)).toEqual(['top', 'mid', 'leaf'])
  })
})

describe('RFC-022 findAgentsDependingOn (LIKE substring guard)', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('rejects LIKE substring false positive ("foo" in "foobar")', async () => {
    // Seed an agent whose dependsOn contains 'foobar', not 'foo'. A naive
    // LIKE %foo% pre-filter would match this row; the JSON.parse + includes
    // second pass MUST reject it.
    await seed(db, { name: 'foo' }, { name: 'foobar' })
    await seed(db, { name: 'caller', dependsOn: ['foobar'] })

    expect(await findAgentsDependingOn(db, 'foo')).toEqual([])
    expect(await findAgentsDependingOn(db, 'foobar')).toEqual(['caller'])
  })
})
