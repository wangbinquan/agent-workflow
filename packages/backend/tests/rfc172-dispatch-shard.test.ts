// RFC-172 route 2 — the (home, shardKey) dispatch/mint re-keying that lets a workgroup MEMBER's
// human clarify answer round-trip to the correct member assignment (all members share the one
// __wg_member__ host node, separated only by node_runs.shard_key). design §6 (S0–S6).
//
// Locks the golden-lock invariant throughout: every non-workgroup path derives shardKey === null,
// so a `(home, null)` composite key collapses byte-for-byte to today's home-only behavior.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { readFileSync } from 'node:fs'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { buildFrontierMintPlan, resolveEntryShardKeys } from '../src/services/taskQuestionDispatch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIN_DEF = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  await db.insert(workflows).values({ id: `wf_${taskId}`, name: 'stub', definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-rfc172',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { retryIndex?: number; shardKey?: string; status?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: over.retryIndex ?? 0,
    iteration: 0,
    ...(over.shardKey !== undefined ? { shardKey: over.shardKey } : {}),
  })
  return id
}

/** Insert a clarify round (+ its FK-referenced node_runs) keyed by intermediaryNodeRunId. */
async function seedRound(
  db: DbClient,
  taskId: string,
  intermediaryNodeRunId: string,
  askingShardKey: string | null,
): Promise<void> {
  const askingRunId = await seedNodeRun(db, taskId, '__wg_member__')
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: '__wg_member__',
    askingNodeRunId: askingRunId,
    intermediaryNodeId: '__wg_clarify__',
    intermediaryNodeRunId,
    iteration: 0,
    questionsJson: '[]',
    answersJson: '[]',
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
    ...(askingShardKey !== null ? { askingShardKey } : {}),
  })
}

/** Insert a task_question and return the full row (what dispatchTaskQuestions passes around). */
async function seedEntry(
  db: DbClient,
  taskId: string,
  e: { originNodeRunId: string; sourceKind: 'self' | 'manual' },
) {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: 'q',
    questionTitle: 'q',
    sourceKind: e.sourceKind,
    roleKind: 'self',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: '__wg_member__',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]!
}

describe('RFC-172 S0 — resolveEntryShardKeys', () => {
  test('clarify entries resolve to their round asking_shard_key; manual → null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const originA = await seedNodeRun(db, taskId, '__wg_clarify__')
    const originB = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, originA, 'assign-A')
    await seedRound(db, taskId, originB, 'assign-B')
    const entryA = await seedEntry(db, taskId, { originNodeRunId: originA, sourceKind: 'self' })
    const entryB = await seedEntry(db, taskId, { originNodeRunId: originB, sourceKind: 'self' })
    // manual §15: synthetic origin (a real node_run to satisfy FK), NO clarify round → null
    const manualOrigin = await seedNodeRun(db, taskId, '__wg_member__')
    const entryM = await seedEntry(db, taskId, {
      originNodeRunId: manualOrigin,
      sourceKind: 'manual',
    })

    const byId = await resolveEntryShardKeys(db, [entryA, entryB, entryM])
    expect(byId.get(entryA.id)).toBe('assign-A')
    expect(byId.get(entryB.id)).toBe('assign-B')
    expect(byId.get(entryM.id)).toBeNull()
  })

  test('golden-lock: a self entry whose round has NULL asking_shard_key resolves to null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, origin, null) // 普通 agent-single self round
    const entry = await seedEntry(db, taskId, { originNodeRunId: origin, sourceKind: 'self' })
    const byId = await resolveEntryShardKeys(db, [entry])
    expect(byId.get(entry.id)).toBeNull()
  })

  test('empty input → empty map (no query)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect((await resolveEntryShardKeys(db, [])).size).toBe(0)
  })
})

describe('RFC-172 S3 — buildFrontierMintPlan shard scoping', () => {
  test('shardKey scopes the inheritance source + retry lineage AND overwrites the rerun shard_key', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Member A ran once (retry 0); member B ran 6 times (retry 5) and is the GLOBAL freshest run.
    await seedNodeRun(db, taskId, '__wg_member__', { shardKey: 'shard-A', retryIndex: 0 })
    await seedNodeRun(db, taskId, '__wg_member__', { shardKey: 'shard-B', retryIndex: 5 })

    // Scoped to shard-A: inherit ONLY shard-A's lineage → retry_index = A's max(0)+1 = 1 (NOT the
    // global max 5+1=6), and the rerun's shard_key is OVERWRITTEN to shard-A (P1-1: A never
    // inherits B's shard).
    const planA = await buildFrontierMintPlan(
      db,
      taskId,
      '__wg_member__',
      null,
      'clarify-answer',
      MIN_DEF,
      'shard-A',
    )
    expect(planA.shardKey).toBe('shard-A')
    expect(planA.values.shardKey).toBe('shard-A')
    expect(planA.values.retryIndex).toBe(1)

    // Golden-lock: undefined = shard-blind → inherit the GLOBAL freshest across ALL shards, retry =
    // max(0,5)+1 = 6 (both are top-level, deterministic), shard_key INHERITED (never overwritten),
    // plan.shardKey collapses to null. Which run is "freshest" is the existing pickFreshestRun
    // tiebreak (id order — non-deterministic for same-ms ULIDs), so assert only that the shard was
    // inherited from a real run, not overwritten/nulled.
    const planGlobal = await buildFrontierMintPlan(
      db,
      taskId,
      '__wg_member__',
      null,
      'clarify-answer',
      MIN_DEF,
      undefined,
    )
    expect(planGlobal.shardKey).toBeNull()
    // inherited from a real run, not overwritten/nulled (values.shardKey is string|null|undefined,
    // so a boolean === check keeps this type-safe under tsc — no toContain(string|null) overload).
    const inheritedShard = planGlobal.values.shardKey
    expect(inheritedShard === 'shard-A' || inheritedShard === 'shard-B').toBe(true)
    expect(planGlobal.values.retryIndex).toBe(6)
  })
})

// S2a wires the shard split into dispatchTaskQuestions' mint loop + reruns mapping. The full
// two-shards → two-reruns integration (workgroup host snapshot end-to-end) lands in S5; this
// source-lock guards the wiring from a silent refactor drop in the meantime.
describe('RFC-172 S2a — dispatch mint-loop shard wiring (source lock)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
    'utf8',
  )
  test('mint loop resolves + splits by shard; reruns map filters entryIds by shard', () => {
    // each frontier node fans out one mint per distinct dispatched-entry shard …
    expect(SRC).toContain('const entryShardById = await resolveEntryShardKeys(db, dispatchEntries)')
    expect(SRC).toContain('[...frontier].flatMap((nodeId) => {')
    // … null shard passed as undefined (never null — else manual-to-member regresses) …
    expect(SRC).toContain('sk === null ? undefined : sk')
    // … and each entry maps to ITS shard's rerun.
    expect(SRC).toContain('shardOf(e) === p.shardKey')
  })
})
