// Locks RFC-022 §design 4.2 — scheduler.prepareNodeRunInjection.
//
// This is the path that gets executed RIGHT BEFORE every spawn of a child
// opencode process. Red here means a regression in one of:
//   1. BFS order across the dependsOn closure (root → BFS children)
//   2. Skills union de-dup (same skill referenced by primary and a dependent
//      must stage exactly once under OPENCODE_CONFIG_DIR/skills/)
//   3. Cycle / missing-dep mapping to NodeStepResult 'failed' (does not throw
//      — scheduler's normal failure path expects a structured result)

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Logger } from '@/util/log'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { getAgent } from './helpers/resourceLookup'
import { prepareNodeRunInjection } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOG,
}

async function seedAgent(
  db: DbClient,
  name: string,
  opts: { dependsOn?: string[]; skills?: string[]; mcp?: string[] } = {},
) {
  return createAgent(db, {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    // RFC-223 (PR-1): skill NAMES with no managed row are repo-local `project`
    // refs (RFC-178). These closure tests exercise the injection union, which
    // preserves project names verbatim.
    skills: (opts.skills ?? []).map((name) => ({ kind: 'project' as const, name })),
    dependsOn: opts.dependsOn ?? [],
    mcp: opts.mcp ?? [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

async function seedManagedSkill(db: DbClient, name: string): Promise<void> {
  // Raw insert keeps the test free of filesystem setup — prepareSkills /
  // resolveSkills only care about the DB row + sourceKind.
  await db.insert(skills).values({
    id: ulid(),
    name,
    description: '',
    sourceKind: 'managed',
    managedPath: `skills/${name}/files`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

describe('RFC-022 scheduler.prepareNodeRunInjection', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('happy path: BFS expands A → B → C, root excluded from dependents', async () => {
    const c = await seedAgent(db, 'c')
    const b = await seedAgent(db, 'b', { dependsOn: [c.id] })
    await seedAgent(db, 'a', { dependsOn: [b.id] })
    const root = await getAgent(db, 'a')
    if (root === null) throw new Error('seed missing')

    const out = await prepareNodeRunInjection(db, '/tmp/app-home', root, NOOP_LOG)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('unreachable')
    expect(out.dependents.map((d) => d.name)).toEqual(['b', 'c'])
    expect(out.resolvedSkills).toEqual([]) // none of A/B/C declared any skill
  })

  test('skills union: de-dupes by name across primary + closure dependents (preserves first-seen order)', async () => {
    await seedManagedSkill(db, 's1')
    await seedManagedSkill(db, 's2')
    await seedManagedSkill(db, 's3')
    const leaf = await seedAgent(db, 'leaf', { skills: ['s2', 's3'] })
    await seedAgent(db, 'top', { dependsOn: [leaf.id], skills: ['s1', 's2'] })
    const root = await getAgent(db, 'top')
    if (root === null) throw new Error('seed missing')

    const out = await prepareNodeRunInjection(db, '/tmp/app-home', root, NOOP_LOG)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('unreachable')
    // Order: top.skills first, then leaf.skills entries not already seen.
    // Same skill referenced from both agents only stages once.
    expect(out.resolvedSkills.map((s) => s.name)).toEqual(['s1', 's2', 's3'])
  })

  test('missing dep maps to NodeStepResult.failed with agent-dependency-not-found in message', async () => {
    await seedAgent(db, 'top')
    // Inject a dangling reference via raw UPDATE (createAgent guard would
    // otherwise refuse). This is the exact scenario the runtime guard exists
    // to catch — when external SQL editing or a race breaks the closure.
    const { sql } = await import('drizzle-orm')
    await db.run(sql`UPDATE agents SET depends_on = '["ghost"]' WHERE name = 'top'`)
    const root = await getAgent(db, 'top')
    if (root === null) throw new Error('seed missing')

    const out = await prepareNodeRunInjection(db, '/tmp/app-home', root, NOOP_LOG)
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('unreachable')
    expect(out.message).toBe('agent-dependency-not-found')
  })

  test('cycle maps to NodeStepResult.failed with the cycle path embedded in message', async () => {
    // Seed leaves first, then close the loop with a raw UPDATE. RFC-223 (PR-1):
    // dependsOn stores IDS, so inject a's id (not its name) to form the cycle.
    const c = await seedAgent(db, 'c')
    const b = await seedAgent(db, 'b', { dependsOn: [c.id] })
    await seedAgent(db, 'a', { dependsOn: [b.id] })
    const idA = (await getAgent(db, 'a'))!.id
    const idB = (await getAgent(db, 'b'))!.id
    const idC = (await getAgent(db, 'c'))!.id
    const { sql } = await import('drizzle-orm')
    await db.run(sql`UPDATE agents SET depends_on = ${JSON.stringify([idA])} WHERE name = 'c'`)
    const root = await getAgent(db, 'a')
    if (root === null) throw new Error('seed missing')

    const out = await prepareNodeRunInjection(db, '/tmp/app-home', root, NOOP_LOG)
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('unreachable')
    // RFC-223 (PR-1): the cycle path is expressed in agent IDS.
    expect(out.message.startsWith('agent-dependency-cycle')).toBe(true)
    expect(out.message).toContain(idA)
    expect(out.message).toContain(idB)
    expect(out.message).toContain(idC)
  })
})
