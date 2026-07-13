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
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { resolveEntryShardKeys } from '../src/services/taskQuestionDispatch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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

async function seedNodeRun(db: DbClient, taskId: string, nodeId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId, status: 'done', retryIndex: 0, iteration: 0 })
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
    const entryM = await seedEntry(db, taskId, { originNodeRunId: manualOrigin, sourceKind: 'manual' })

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
