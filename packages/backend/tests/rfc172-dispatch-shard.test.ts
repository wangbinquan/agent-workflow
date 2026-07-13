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
import type { WorkflowDefinition, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  buildFrontierMintPlan,
  dispatchTaskQuestions,
  resolveEntryShardKeys,
} from '../src/services/taskQuestionDispatch'
import { buildWorkgroupHostSnapshot, WG_MEMBER_NODE_ID } from '../src/services/workgroupLaunch'
import { createManualTaskQuestion } from '../src/services/taskQuestions'

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
  e: { originNodeRunId: string; sourceKind: 'self' | 'manual'; sealed?: boolean },
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
    defaultTargetNodeId: WG_MEMBER_NODE_ID,
    // dispatch readiness gate (§5.2.11): a clarify-derived entry must be sealed before dispatch.
    sealedAt: e.sealed ? Date.now() : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]!
}

/** A minimal 2-agent workgroup config; buildWorkgroupHostSnapshot turns it into the 3-node host
 *  snapshot (__wg_leader__ / __wg_member__ / __wg_clarify__) all members share. */
const WG_CONFIG: WorkgroupRuntimeConfig = {
  workgroupId: 'wg1',
  workgroupName: 'squad',
  mode: 'leader_worker',
  leaderMemberId: 'm-lead',
  switches: { shareOutputs: true, directMessages: false, blackboard: false },
  maxRounds: 10,
  completionGate: false,
  instructions: '',
  goal: 'g',
  members: [
    {
      id: 'm-lead',
      memberType: 'agent',
      agentName: 'wg-lead',
      userId: null,
      displayName: 'lead',
      roleDesc: '',
    },
    {
      id: 'm-coder',
      memberType: 'agent',
      agentName: 'wg-coder',
      userId: null,
      displayName: 'coder',
      roleDesc: '',
    },
  ],
}

/** Seed a task whose workflow snapshot IS the workgroup host snapshot, so __wg_member__ is a real
 *  (clarify-channel-only → upstream-free) frontier node dispatchTaskQuestions can mint against. */
async function seedWorkgroupTask(db: DbClient, taskId: string): Promise<void> {
  await db.insert(workflows).values({ id: `wf_${taskId}`, name: 'stub', definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(buildWorkgroupHostSnapshot(WG_CONFIG)),
    repoPath: '/tmp/aw-rfc172-wg',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
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

// S5 — the end-to-end proof S2a's source-lock stands in for: drive TWO member self-clarify answers
// (asking_shard_key A / B on the ONE __wg_member__ host node) through the real dispatchTaskQuestions
// pipeline and assert each answer round-trips to ITS OWN member assignment — the bug this whole RFC
// exists to kill (member B's answer must NOT ride member A's rerun). The null-shard golden lock (a
// non-workgroup self dispatch still mints exactly one rerun) is covered by the entire rfc128-p5-bc
// suite — every one of its self dispatches carries shardOf → null and still expects one rerun.
describe('RFC-172 S5 — two member shards dispatch to two shard-correct reruns (end-to-end)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  test('each member self-answer mints a rerun on ITS OWN shard; entryIds never cross members', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // Two assignments share __wg_member__, separated only by shard_key. Each has a PRIOR run
    // (assertSafeFrontierTarget's runnable proof + the scoped inheritance source) …
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-A' })
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-B' })
    // … and a sealed, answered self clarify round whose intermediary clarify run is the entry origin
    // resolveEntryShardKeys joins back to (→ asking_shard_key).
    const originA = await seedNodeRun(db, taskId, '__wg_clarify__')
    const originB = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, originA, 'assign-A')
    await seedRound(db, taskId, originB, 'assign-B')
    const entryA = await seedEntry(db, taskId, {
      originNodeRunId: originA,
      sourceKind: 'self',
      sealed: true,
    })
    const entryB = await seedEntry(db, taskId, {
      originNodeRunId: originB,
      sourceKind: 'self',
      sealed: true,
    })

    const res = await dispatchTaskQuestions(db, taskId, [entryA.id, entryB.id], actor)

    // TWO reruns minted — one per shard, NOT one collapsed rerun for the shared node.
    expect(res.reruns.length).toBe(2)
    const byShard = new Map<string | null, { entryIds: string[]; nodeId: string }>()
    for (const r of res.reruns) {
      const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, r.nodeRunId)))[0]
      byShard.set(run?.shardKey ?? null, { entryIds: r.entryIds, nodeId: r.targetNodeId })
    }
    // Each assignment got its OWN rerun on __wg_member__ …
    expect(byShard.get('assign-A')?.nodeId).toBe(WG_MEMBER_NODE_ID)
    expect(byShard.get('assign-B')?.nodeId).toBe(WG_MEMBER_NODE_ID)
    // … carrying ONLY its own member's entry (the core anti-crosstalk invariant).
    expect(byShard.get('assign-A')?.entryIds).toEqual([entryA.id])
    expect(byShard.get('assign-B')?.entryIds).toEqual([entryB.id])
    // Both entries stamped dispatched, neither deferred.
    expect([...res.dispatchedEntryIds].sort()).toEqual([entryA.id, entryB.id].sort())
    expect(res.deferred).toEqual([])
  })
})

// R2-T5 — a manual question (§15) has no clarify round, so resolveEntryShardKeys maps it to null;
// dispatched at __wg_member__ it would inherit the global-freshest member's shard and hijack that
// assignment. createManualTaskQuestion must REJECT __wg_member__ as a target (leader/plain agents
// stay allowed — they are not multi-shard). The guard is a literal in taskQuestions.ts (importing
// WG_MEMBER_NODE_ID there risks a module-init cycle); this test source-locks the two to match.
describe('RFC-172 R2-T5 — manual question cannot target the shared __wg_member__ host node', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  test('createManualTaskQuestion(target=__wg_member__) → rejected, nothing inserted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // __wg_member__ HAS a prior run, so this is NOT the never-run rejection — it is the R2-T5 guard.
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-A' })
    let threw: unknown = null
    try {
      await createManualTaskQuestion(
        db,
        taskId,
        { title: 't', body: 'b', targetNodeId: WG_MEMBER_NODE_ID },
        actor,
      )
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('manual-question-workgroup-member-target')
    // nothing inserted (fail-fast before the insert tx).
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0)
  })

  test('source lock: the guard literal in taskQuestions.ts equals WG_MEMBER_NODE_ID', () => {
    // WG_MEMBER_NODE_ID is the source of truth; the guard hard-codes its value to dodge the import
    // cycle. If the constant is ever renamed, this catches the drift.
    expect(WG_MEMBER_NODE_ID).toBe('__wg_member__')
    const SRC = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestions.ts'),
      'utf8',
    )
    expect(SRC).toContain("if (target === '__wg_member__') {")
    expect(SRC).toContain('manual-question-workgroup-member-target')
  })
})
