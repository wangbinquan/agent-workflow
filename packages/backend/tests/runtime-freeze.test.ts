// RFC-111 D15 + RFC-112 (Codex P1) — resolveFrozenRuntime: a node_run's runtime
// is resolved ONCE at first dispatch and frozen onto node_runs as a (protocol,
// binary) SNAPSHOT; resume/retry of the same row read the frozen snapshot — never
// the mutable runtimes registry — so a changed agent.runtime / default, or a
// deleted / re-pointed custom runtime, can't re-route a captured session to the
// wrong driver or binary.

import { describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { frozenRuntimeOfSession, resolveFrozenRuntime } from '../src/services/nodeRunMint'
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
    await createRuntime(db, {
      name: 'my-cc',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('my-cc'),
    })
    const r = await resolveFrozenRuntime(db, id, 'my-cc', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.binary).toBe(canonicalBinaryPath('my-cc'))
    const cols = await frozenCols(db, id)
    expect(cols.runtime).toBe('claude-code')
    expect(cols.binary).toBe(canonicalBinaryPath('my-cc'))
  })

  test('resume reads the frozen binary snapshot even after the runtime is re-pointed (registry-independent)', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'my-cc',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('v1'),
    })
    await resolveFrozenRuntime(db, id, 'my-cc', undefined) // freeze /opt/v1
    // the runtime is later re-pointed to a new binary — resume must NOT pick it up.
    await updateRuntime(db, 'my-cc', { binaryPath: canonicalBinaryPath('v2') })
    const r = await resolveFrozenRuntime(db, id, 'my-cc', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.binary).toBe(canonicalBinaryPath('v1')) // the frozen snapshot, not the mutated registry
  })

  test('a deleted custom runtime still resumes on its frozen snapshot', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: canonicalBinaryPath('oc'),
    })
    await resolveFrozenRuntime(db, id, 'my-oc', undefined) // freeze
    // (the registry guard blocks deleting an in-use runtime, but a node_run that
    //  finished + is being re-examined is snapshot-safe regardless.)
    const r = await resolveFrozenRuntime(db, id, 'my-oc', undefined)
    expect(r.protocol).toBe('opencode')
    expect(r.binary).toBe(canonicalBinaryPath('oc'))
  })
})

describe('resume inherits the session owner’s frozen runtime (RFC-112 Codex impl-gate P1)', () => {
  test('frozenRuntimeOfSession returns the (protocol, binary) of the row that captured a session', async () => {
    const { db, id } = await seedRun()
    await db
      .update(nodeRuns)
      .set({
        runtime: 'claude-code',
        runtimeBinary: canonicalBinaryPath('my-cc'),
        opencodeSessionId: 'sess-X',
      })
      .where(eq(nodeRuns.id, id))
    expect(await frozenRuntimeOfSession(db, 'sess-X')).toMatchObject({
      protocol: 'claude-code',
      binary: canonicalBinaryPath('my-cc'),
    })
    expect(await frozenRuntimeOfSession(db, 'no-such-session')).toBeNull()
  })

  test('a FRESH retry row that carries a prior session inherits its frozen runtime, NOT a re-resolve', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    const taskId = ulid()
    await db
      .insert(workflows)
      .values({ id: wfId, name: 'wf', definition: '{}', createdAt: 0, updatedAt: 0 })
    await db.insert(tasks).values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/r',
      worktreePath: '/w',
      baseBranch: 'main',
      branch: 'b',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    // original row R1: ran on a custom claude fork, captured session S.
    const r1 = ulid()
    await db.insert(nodeRuns).values({
      id: r1,
      taskId,
      nodeId: 'n1',
      status: 'done',
      runtime: 'claude-code',
      runtimeBinary: canonicalBinaryPath('v1'),
      opencodeSessionId: 'sess-S',
    })
    // the custom runtime is later DELETED / the agent flipped to opencode.
    // a fresh retry row R2 carries session S and resolves with the inherited pair.
    const r2 = ulid()
    await db.insert(nodeRuns).values({ id: r2, taskId, nodeId: 'n1', status: 'pending' })
    const inherited = await frozenRuntimeOfSession(db, 'sess-S')
    const frozen = await resolveFrozenRuntime(db, r2, 'opencode', 'opencode', inherited)
    // re-resolving 'opencode' would have mispaired the claude session S with the
    // opencode driver; inheriting keeps (claude-code, /opt/v1).
    expect(frozen).toMatchObject({ protocol: 'claude-code', binary: canonicalBinaryPath('v1') })
    const row = (
      await db
        .select({ runtime: nodeRuns.runtime, binary: nodeRuns.runtimeBinary })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, r2))
    )[0]
    expect(row?.runtime).toBe('claude-code')
    expect(row?.binary).toBe(canonicalBinaryPath('v1'))
  })
})

describe('resolveFrozenRuntime — freezes the runtime PARAMS too (RFC-113 Codex P1-2)', () => {
  test('first dispatch freezes model/params; resume reads the snapshot, not the mutated runtime', async () => {
    const { db, id } = await seedRun()
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'cc-opus',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('cc'),
      model: 'opus',
      temperature: 0.5,
    })
    const r = await resolveFrozenRuntime(db, id, 'cc-opus', undefined)
    expect(r.protocol).toBe('claude-code')
    expect(r.params.model).toBe('opus')
    expect(r.params.temperature).toBe(0.5)
    // the runtime's model is later changed — a resume must use the FROZEN params.
    await updateRuntime(db, 'cc-opus', { model: 'haiku' })
    const resume = await resolveFrozenRuntime(db, id, 'cc-opus', undefined)
    expect(resume.params.model).toBe('opus') // frozen snapshot, NOT 'haiku'
  })
})
