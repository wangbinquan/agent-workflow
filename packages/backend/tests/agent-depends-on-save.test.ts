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
import { getAgent } from './helpers/resourceLookup'
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

// RFC-223 (PR-1): dependsOn is stored + validated BY ID. createAgent resolves
// the seed's dependsOn NAMES → ids, and this returns a name→id map so the
// tests can pass the resolved ids to validateDependsOn / resolveDependsClosure
// exactly as the production callers do.
async function seed(db: DbClient, ...rows: AgentSeed[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const r of rows) {
    const dependsOn: string[] = []
    for (const name of r.dependsOn ?? []) {
      dependsOn.push((await getAgent(db, name))?.id ?? name)
    }
    const created = await createAgent(db, {
      name: r.name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn,
      mcp: r.mcp ?? [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    ids.set(r.name, created.id)
  }
  return ids
}

describe('RFC-022 validateDependsOn (save-time guard)', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('rejects unknown dependsOn id', async () => {
    const ids = await seed(db, { name: 'orchestrator' })
    // A bogus id that resolves to no row → not-found (validateDependsOn is fed
    // already-resolved ids; a survivor that is really a name lands here too).
    await expect(
      validateDependsOn(db, ids.get('orchestrator')!, ['no-such-agent-id']),
    ).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
      details: { notFound: ['no-such-agent-id'] },
    })
  })

  test('rejects a name token instead of treating it as identity after the PR-8 flip', async () => {
    await expect(validateDependsOn(db, 'new-id', ['fresh'])).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
      details: { notFound: ['fresh'] },
    })
  })

  test('rejects self-reference by canonical id before the row is persisted', async () => {
    await expect(validateDependsOn(db, 'new-id', ['new-id'])).rejects.toMatchObject({
      code: 'agent-dependency-self',
      details: { id: 'new-id' },
    })
  })

  test('rejects cycle and reports just the loop in cyclePath (not the full prefix)', async () => {
    // Seed leaves first so createAgent's save-time guard accepts each row:
    // c → (nothing), b → c, a → b. Now attempt to put c.dependsOn = [a],
    // which would close the loop A → B → C → A. validateDependsOn runs on
    // the *proposed* row (c). RFC-223 PR-1: the cycle path is expressed in IDS.
    const ids = await seed(
      db,
      { name: 'c' },
      { name: 'b', dependsOn: ['c'] },
      { name: 'a', dependsOn: ['b'] },
    )
    const [idA, idB, idC] = [ids.get('a')!, ids.get('b')!, ids.get('c')!]
    await expect(validateDependsOn(db, idC, [idA])).rejects.toMatchObject({
      code: 'agent-dependency-cycle',
    })
    try {
      await validateDependsOn(db, idC, [idA])
    } catch (e) {
      const err = e as DomainError
      // The loop is "c → a → b → c"; the BFS root is the synthetic 'c' so
      // the path starts with c's id and closes back on it.
      const path = (err.details as { cyclePath: string[] }).cyclePath
      expect(path[0]).toBe(idC)
      expect(path[path.length - 1]).toBe(idC)
      expect(path).toContain(idA)
      expect(path).toContain(idB)
    }
  })

  test('accepts a valid diamond (A → B,C ; B → D ; C → D) and dedupes input', async () => {
    // Diamond convergence on D is legal — not a cycle. validateDependsOn
    // should accept and silently dedupe duplicate ids in the input.
    const ids = await seed(
      db,
      { name: 'd' },
      { name: 'b', dependsOn: ['d'] },
      { name: 'c', dependsOn: ['d'] },
    )
    const [b, c, d] = [ids.get('b')!, ids.get('c')!, ids.get('d')!]
    await expect(validateDependsOn(db, 'new-a-id', [b, c, b, d, c])).resolves.toBeUndefined()
  })

  test('resolveDependsClosure: happy path returns BFS order with root first; allowMissing skips dangling', async () => {
    // Leaves first, then parents. The "ghost" reference is injected post-hoc via
    // a raw UPDATE (with a bogus id) so createAgent's guard doesn't trip during
    // seeding. RFC-223 PR-1: dependsOn stores IDS, so the raw JSON uses mid's id.
    const ids = await seed(
      db,
      { name: 'leaf' },
      { name: 'mid', dependsOn: ['leaf'] },
      { name: 'top', dependsOn: ['mid'] },
    )
    const midId = ids.get('mid')!
    const { sql } = await import('drizzle-orm')
    await db.run(
      sql`UPDATE agents SET depends_on = ${JSON.stringify([midId, 'ghost-id'])} WHERE name = 'top'`,
    )
    const top = await getAgent(db, 'top')
    expect(top).not.toBeNull()
    if (top === null) throw new Error('unreachable')

    // Default: throws on missing
    await expect(resolveDependsClosure(db, top)).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
    })

    // allowMissing: missing 'ghost-id' silently skipped, traversal continues
    const closure = await resolveDependsClosure(db, top, { allowMissing: true })
    expect(closure.ok).toBe(true)
    if (closure.ok === false) throw new Error('unreachable')
    expect(closure.agents.map((a) => a.name)).toEqual(['top', 'mid', 'leaf'])
  })
})

describe('RFC-223 findAgentsDependingOn (id match + JSON exactness)', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('matches by agent id (JSON.parse + includes exactness, not a coincidental substring)', async () => {
    // dependsOn stores IDS. 'caller' depends on 'foobar' (→ foobar's id); a
    // lookup by foo's id must NOT match caller, and by foobar's id must.
    const ids = await seed(db, { name: 'foo' }, { name: 'foobar' })
    const callerIds = await seed(db, { name: 'caller', dependsOn: ['foobar'] })

    expect(await findAgentsDependingOn(db, ids.get('foo')!)).toEqual([])
    expect(await findAgentsDependingOn(db, ids.get('foobar')!)).toEqual([
      { id: callerIds.get('caller')!, name: 'caller' },
    ])
  })
})
