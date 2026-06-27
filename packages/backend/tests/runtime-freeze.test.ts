// RFC-111 D15 + RFC-112 (Codex P1) — resolveFrozenRuntime: a node_run's runtime
// is resolved ONCE at first dispatch and frozen onto node_runs as a (protocol,
// binary) SNAPSHOT; resume/retry of the same row read the frozen snapshot — never
// the mutable runtimes registry — so a changed agent.runtime / default, or a
// deleted / re-pointed custom runtime, can't re-route a captured session to the
// wrong driver or binary.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { resolveFrozenRuntime } from '../src/services/nodeRunMint'
import { createRuntime, seedBuiltinRuntimes, updateRuntime } from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedRun(): Promise<{ db: DbClient; id: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return { db, id }
}

async function frozenCols(
  db: DbClient,
  id: string,
): Promise<{ runtime: unknown; binary: unknown }> {
  const row = (
    await db
      .select({ runtime: nodeRuns.runtime, binary: nodeRuns.runtimeBinary })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, id))
  )[0]
  return { runtime: row?.runtime ?? null, binary: row?.binary ?? null }
}

describe('resolveFrozenRuntime — built-in protocols (RFC-111 D15)', () => {
  test('first dispatch resolves the protocol + freezes it (built-in → null binary)', async () => {
    const { db, id } = await seedRun()
    expect((await frozenCols(db, id)).runtime).toBeNull()
    const r = await resolveFrozenRuntime(db, id, 'claude-code', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.binary).toBeNull()
    const cols = await frozenCols(db, id)
    expect(cols.runtime).toBe('claude-code') // frozen protocol
    expect(cols.binary).toBeNull()
  })

  test('resume reads the frozen protocol even after agent.runtime changes (P1-2)', async () => {
    const { db, id } = await seedRun()
    await resolveFrozenRuntime(db, id, 'claude-code', undefined) // freeze claude
    const r = await resolveFrozenRuntime(db, id, 'opencode', 'opencode') // agent flipped
    expect(r.protocol).toBe('claude-code')
  })

  test('first dispatch falls back to config.defaultRuntime, then opencode', async () => {
    const a = await seedRun()
    expect((await resolveFrozenRuntime(a.db, a.id, null, 'claude-code')).protocol).toBe(
      'claude-code',
    )
    const b = await seedRun()
    expect((await resolveFrozenRuntime(b.db, b.id, null, null)).protocol).toBe('opencode')
    expect((await frozenCols(b.db, b.id)).runtime).toBe('opencode')
  })

  test('an unrecognized frozen protocol re-resolves to opencode (legacy NULL safety)', async () => {
    const { db, id } = await seedRun()
    await db.update(nodeRuns).set({ runtime: 'bogus-runtime' }).where(eq(nodeRuns.id, id))
    expect((await resolveFrozenRuntime(db, id, null, null)).protocol).toBe('opencode')
  })
})

describe('resolveFrozenRuntime — custom runtimes freeze a (protocol, binary) snapshot (RFC-112 P1)', () => {
  test('first dispatch of a custom runtime freezes its protocol + binary', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, { name: 'my-cc', protocol: 'claude-code', binaryPath: '/opt/my-cc' })
    const r = await resolveFrozenRuntime(db, id, 'my-cc', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.binary).toBe('/opt/my-cc')
    const cols = await frozenCols(db, id)
    expect(cols.runtime).toBe('claude-code')
    expect(cols.binary).toBe('/opt/my-cc')
  })

  test('resume reads the frozen binary snapshot even after the runtime is re-pointed (registry-independent)', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, { name: 'my-cc', protocol: 'claude-code', binaryPath: '/opt/v1' })
    await resolveFrozenRuntime(db, id, 'my-cc', undefined) // freeze /opt/v1
    // the runtime is later re-pointed to a new binary — resume must NOT pick it up.
    await updateRuntime(db, 'my-cc', { binaryPath: '/opt/v2' })
    const r = await resolveFrozenRuntime(db, id, 'my-cc', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.binary).toBe('/opt/v1') // the frozen snapshot, not the mutated registry
  })

  test('a deleted custom runtime still resumes on its frozen snapshot', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, { name: 'my-oc', protocol: 'opencode', binaryPath: '/opt/oc' })
    await resolveFrozenRuntime(db, id, 'my-oc', undefined) // freeze
    // (the registry guard blocks deleting an in-use runtime, but a node_run that
    //  finished + is being re-examined is snapshot-safe regardless.)
    const r = await resolveFrozenRuntime(db, id, 'my-oc', undefined)
    expect(r.protocol).toBe('opencode')
    expect(r.binary).toBe('/opt/oc')
  })
})
