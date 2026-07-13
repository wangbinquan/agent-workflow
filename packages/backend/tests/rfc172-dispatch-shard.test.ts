// RFC-172 route 2 — the (home, shardKey) dispatch/mint re-keying that lets a workgroup MEMBER's
// human clarify answer round-trip to the correct member assignment (all members share the one
// __wg_member__ host node, separated only by node_runs.shard_key). design §6 (S0–S6).
//
// Locks the golden-lock invariant throughout: every non-workgroup path derives shardKey === null,
// so a `(home, null)` composite key collapses byte-for-byte to today's home-only behavior.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
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
import { createManualTaskQuestion, reassignTaskQuestion } from '../src/services/taskQuestions'
import { hasOpenDispatchedEntryOnHome } from '../src/services/clarifyRerunLedger'
import { abandonSupersededMergeStates } from '../src/services/lifecycle'
import type { nodeRuns as nodeRunsTable } from '../src/db/schema'

// Monotonic so seed ORDER == id ORDER — several shard tests depend on "the run seeded last is the
// freshest" (the shard-blind lineage window picks by ULID id; a same-ms random ULID would break it).
const ulid = monotonicFactory()

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
  over: { retryIndex?: number; shardKey?: string; status?: string; mergeState?: string } = {},
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
    ...(over.mergeState !== undefined ? { mergeState: over.mergeState as 'isolating' } : {}),
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
  e: {
    originNodeRunId: string
    sourceKind: 'self' | 'manual'
    sealed?: boolean
    /** in-flight seed: an already-dispatched entry (dispatched_at + trigger_run_id → its rerun). */
    dispatchedAt?: number
    triggerRunId?: string
  },
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
    ...(e.dispatchedAt !== undefined ? { dispatchedAt: e.dispatchedAt, dispatchedBy: 'u1' } : {}),
    ...(e.triggerRunId !== undefined ? { triggerRunId: e.triggerRunId } : {}),
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
 *  (clarify-channel-only → upstream-free) frontier node dispatchTaskQuestions can mint against.
 *  workgroupId + config are set so `isTurnEngineWorkgroupTask` is true — the R2-T5 ban is gated on
 *  it (an ordinary workflow with a coincidentally-named node must NOT trip the ban). */
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
    workgroupId: WG_CONFIG.workgroupId,
    workgroupConfigJson: JSON.stringify(WG_CONFIG),
  })
}

/** Seed an ORDINARY (non-workgroup) task whose snapshot has an agent node literally named
 *  '__wg_member__' — the P2 case: the R2-T5 ban must NOT fire here (no shard ambiguity). */
async function seedOrdinaryTaskWithMemberNamedNode(db: DbClient, taskId: string): Promise<void> {
  const def = {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: '__wg_member__', kind: 'agent-single', agentName: 'a' }],
    edges: [],
  }
  await db.insert(workflows).values({ id: `wf_${taskId}`, name: 'stub', definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'ordinary-fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc172-ord',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    // NO workgroupId → isTurnEngineWorkgroupTask=false → ban skipped.
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
// assignment. The ban is enforced at EVERY point a manual target is set/moved/used: create +
// reassign (taskQuestions.ts) + dispatch backstop (taskQuestionDispatch.ts, for pre-upgrade rows).
// It is GATED on the task actually being a turn-engine workgroup — an ordinary workflow with a node
// coincidentally named __wg_member__ has no shard ambiguity and stays allowed (Codex impl-gate P2).
describe('RFC-172 R2-T5 — manual question cannot target the shared __wg_member__ host node', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  test('create(target=__wg_member__) on a workgroup task → rejected, nothing inserted', async () => {
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
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0)
  })

  test('P2: create(target=__wg_member__) on an ORDINARY workflow → ALLOWED (no shard ambiguity)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedOrdinaryTaskWithMemberNamedNode(db, taskId)
    // The node has a prior run (manual reruns its handler); NOT a workgroup task → ban skipped.
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID)
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: WG_MEMBER_NODE_ID },
      actor,
    )
    const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.overrideTargetNodeId).toBe(WG_MEMBER_NODE_ID) // created, not rejected
  })

  test('P1: reassign a leader-targeted manual onto __wg_member__ → rejected (bypass closed)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // Both host nodes have prior runs so neither hits the never-run gate.
    await seedNodeRun(db, taskId, '__wg_leader__')
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-A' })
    // Manual created for the leader (singleton, shard null) — allowed.
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: '__wg_leader__' },
      actor,
    )
    // …then MOVED onto the shared member node → the R2-T5 reassign guard rejects.
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, id, WG_MEMBER_NODE_ID, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('manual-question-workgroup-member-target')
    // target unchanged (reassign failed before the update tx).
    const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.overrideTargetNodeId).toBe('__wg_leader__')
  })

  test('P1: dispatch backstop — a pre-upgrade manual@__wg_member__ row is refused, not hijacked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // Two member runs (a global-freshest exists to be hijacked); a manual row already targeting the
    // shared node — hand-seeded to simulate a row created BEFORE the create/reassign guards existed.
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-A' })
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-B', retryIndex: 3 })
    const origin = await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID)
    const manual = await seedEntry(db, taskId, {
      originNodeRunId: origin,
      sourceKind: 'manual',
      sealed: true,
    })
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [manual.id], actor)
    } catch (e) {
      threw = e
    }
    // the backstop rejects ANY shard-less entry at __wg_member__ (manual is always null-shard).
    expect((threw as { code?: string }).code).toBe('workgroup-member-shardless-dispatch')
    // NOT dispatched — no rerun minted (would-be hijack prevented).
    const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, manual.id)))[0]
    expect(row?.dispatchedAt).toBeNull()
  })

  test('source lock: guards gate on isTurnEngineWorkgroupTask + literal matches WG_MEMBER_NODE_ID', () => {
    // WG_MEMBER_NODE_ID is the source of truth; the guards hard-code its value to dodge the import
    // cycle (workgroupLaunch pulls in heavy services). If the constant is renamed, this catches it.
    expect(WG_MEMBER_NODE_ID).toBe('__wg_member__')
    const SVC = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestions.ts'),
      'utf8',
    )
    expect(SVC).toContain("if (target !== '__wg_member__') return")
    expect(SVC).toContain('isTurnEngineWorkgroupTask(t)') // P2 gating
    expect(SVC).toContain('manual-question-workgroup-member-target')
    const DISP = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
      'utf8',
    )
    // dispatch backstop: any shard-less entry at __wg_member__ on a turn-engine workgroup → reject.
    expect(DISP).toContain("effectiveTarget(e) === '__wg_member__'")
    expect(DISP).toContain('workgroup-member-shardless-dispatch')
    expect(DISP).toContain('isTurnEngineWorkgroupTask(taskRow)')
  })
})

// T5 — the in-flight dispatch gate (assertNoInFlightDispatch / findOpenDispatchTarget) keys on the
// (target, SHARD) a batch mints, not the target node alone. Two workgroup members share the ONE
// __wg_member__ host node; member A's in-flight clarify rerun (shard A) must NOT block member B's
// clarify-answer dispatch (shard B). Same shard still serializes. Golden-lock: non-workgroup batches
// resolve every shard to null → {target → {null}} → the gate is byte-identical to today.
describe('RFC-172b T5 — in-flight gate is per-(target, shard); sibling members do not block', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  /** member `shard` DISPATCHED with an in-flight (pending) rerun — the obligation the gate reads. */
  async function seedInFlight(db: DbClient, taskId: string, shard: string): Promise<void> {
    const clarify = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, clarify, shard)
    const rerun = await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, {
      shardKey: shard,
      status: 'pending',
    })
    await seedEntry(db, taskId, {
      originNodeRunId: clarify,
      sourceKind: 'self',
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: rerun,
    })
  }

  /** a fresh, sealed, UNDISPATCHED member answer on `shard`. */
  async function seedFresh(db: DbClient, taskId: string, shard: string) {
    const clarify = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, clarify, shard)
    return seedEntry(db, taskId, { originNodeRunId: clarify, sourceKind: 'self', sealed: true })
  }

  test('member A in-flight (shard A) does NOT block member B dispatch (shard B) → mints B rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // member B's prior run first (lower id → clean shard-B inheritance), then member A in-flight.
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-B' })
    await seedInFlight(db, taskId, 'assign-A')
    const entryB = await seedFresh(db, taskId, 'assign-B')

    // the (target, shard) SKIP excludes member A (shard A ∉ mint {B}) — deterministic, independent
    // of run topology — so B dispatches through the sibling's in-flight rerun.
    const res = await dispatchTaskQuestions(db, taskId, [entryB.id], actor)
    expect(res.reruns.length).toBe(1)
    const run = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, res.reruns[0]!.nodeRunId))
    )[0]
    expect(run?.shardKey).toBe('assign-B')
  })

  test('SAME shard still serializes — member A in-flight (shard A) blocks another shard-A dispatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // in-flight rerun (shard A) is ALSO the frontier-safe prior run; NO extra shard-A done run
    // (a higher-id shard-A done would mask the anchor and wrongly release the block).
    await seedInFlight(db, taskId, 'assign-A')
    const entryA2 = await seedFresh(db, taskId, 'assign-A')

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA2.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-node-dispatch-in-flight')
  })
})

// T6 (S4) — the self-rollback open-ledger preflight (selfHomeHasOpenLedger → hasOpenDispatchedEntryOnHome)
// keys on the rolling-back member's shard: a SIBLING member's open ledger on the shared __wg_member__
// must NOT block this member's rollback. Golden-lock: shard-blind (undefined) blocks on any open
// ledger on the home, exactly as pre-172b.
describe('RFC-172b T6 — hasOpenDispatchedEntryOnHome shard scoping (S4)', () => {
  type Run = typeof nodeRunsTable.$inferSelect
  const mkRun = (over: Partial<Run>): Run =>
    ({
      id: 'r',
      taskId: 't',
      nodeId: WG_MEMBER_NODE_ID,
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      rerunCause: null,
      startedAt: null,
      shardKey: null,
      ...over,
    }) as Run
  // member B has an in-flight (pending) rerun on shard B — an OPEN ledger on the shared home.
  const memberBEntry = {
    originNodeRunId: 'oB',
    triggerRunId: 'rerunB',
    defaultTargetNodeId: WG_MEMBER_NODE_ID,
    overrideTargetNodeId: null,
    roleKind: 'self' as const,
    sourceKind: 'self' as const,
  }
  const runs = [mkRun({ id: 'rerunB', status: 'pending', shardKey: 'B' })]
  const shardOf = (e: { originNodeRunId: string }) => (e.originNodeRunId === 'oB' ? 'B' : null)

  test("member A (shard A) rollback is NOT blocked by member B's open ledger (shard B)", () => {
    expect(
      hasOpenDispatchedEntryOnHome(
        WG_MEMBER_NODE_ID,
        [memberBEntry],
        runs,
        new Set(),
        'clarify-answer',
        'assign-A', // member A's shard — B's ledger is a different shard → not MY open ledger
        shardOf,
      ),
    ).toBe(false)
  })

  test('golden-lock: shard-blind (undefined) IS blocked by any open ledger on the home (今日行为)', () => {
    expect(
      hasOpenDispatchedEntryOnHome(
        WG_MEMBER_NODE_ID,
        [memberBEntry],
        runs,
        new Set(),
        'clarify-answer',
      ),
    ).toBe(true)
  })

  test('same member (shard B) rollback IS blocked by its OWN open ledger', () => {
    expect(
      hasOpenDispatchedEntryOnHome(
        WG_MEMBER_NODE_ID,
        [memberBEntry],
        runs,
        new Set(),
        'clarify-answer',
        'B', // rolling back member B — its own in-flight rerun blocks (no self-clobber)
        shardOf,
      ),
    ).toBe(true)
  })
})

// Codex impl-gate P1 — the (target,shard) dispatch SKIP lets member B mint while member A runs, but
// the same-tx supersede retirement (abandonSupersededMergeStates) is node-wide → it would abandon
// member A's still-running merge_state. The fix shard-scopes the abandon so a sibling member's run
// survives. Golden-lock: undefined = node-wide (today).
describe('RFC-172b Codex P1 — abandonSupersededMergeStates is shard-scoped', () => {
  async function seedRun(
    db: DbClient,
    taskId: string,
    shard: string,
    id?: string,
  ): Promise<string> {
    return seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, {
      shardKey: shard,
      status: 'running',
      mergeState: 'isolating',
      ...(id ? {} : {}),
    })
  }

  test('shardKey=B retires only shard-B priors; a running sibling (shard A) survives', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    const runA = await seedRun(db, taskId, 'assign-A') // member A: running + isolating
    const runB = await seedRun(db, taskId, 'assign-B') // member B: prior generation
    const superseding = ulid() // a higher-id new member-B run supersedes

    const n = abandonSupersededMergeStates({
      db,
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      iteration: 0,
      supersededByRunId: superseding,
      shardKey: 'assign-B',
    })
    expect(n).toBe(1) // only runB (shard B) retired
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const byId = new Map(rows.map((r) => [r.id, r.mergeState]))
    expect(byId.get(runA)).toBe('isolating') // sibling member A UNTOUCHED (the fix)
    expect(byId.get(runB)).toBe('abandoned')
  })

  test('golden-lock: undefined shardKey retires ALL priors node-wide (今日行为)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    const runA = await seedRun(db, taskId, 'assign-A')
    const runB = await seedRun(db, taskId, 'assign-B')
    const n = abandonSupersededMergeStates({
      db,
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      iteration: 0,
      supersededByRunId: ulid(),
      // no shardKey → node-wide
    })
    expect(n).toBe(2)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const byId = new Map(rows.map((r) => [r.id, r.mergeState]))
    expect(byId.get(runA)).toBe('abandoned')
    expect(byId.get(runB)).toBe('abandoned')
  })
})

// Codex impl-gate P2 — a pre-RFC-172 legacy DISPATCHED ledger on __wg_member__ resolves to a null
// shard; the (target,shard) SKIP must NOT skip it for a legitimate member batch (its trigger might
// be THIS member's), else same-shard serialization breaks. A null-shard in-flight ledger is a
// conservative node-wide blocker.
describe('RFC-172b Codex P2 — a shard-less legacy in-flight ledger blocks a member dispatch', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  test('a dispatched manual (null shard) in-flight on __wg_member__ blocks member B dispatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedWorkgroupTask(db, taskId)
    // member B's fresh answer (shard B) + a prior shard-B run — seeded FIRST so its runs have lower
    // ids than the legacy rerun below (a real legacy in-flight ledger is the LATEST run on the node;
    // a higher-id sibling done run would otherwise mask it in the shard-blind lineage window).
    await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { shardKey: 'assign-B' })
    const clarifyB = await seedNodeRun(db, taskId, '__wg_clarify__')
    await seedRound(db, taskId, clarifyB, 'assign-B')
    const entryB = await seedEntry(db, taskId, {
      originNodeRunId: clarifyB,
      sourceKind: 'self',
      sealed: true,
    })
    // Legacy manual, dispatched, with an in-flight (pending) rerun → null shard (no clarify round).
    // Seeded LAST → highest id → the freshest run in its own lineage window → genuinely unconsumed.
    const legacyOrigin = await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID)
    const legacyRerun = await seedNodeRun(db, taskId, WG_MEMBER_NODE_ID, { status: 'pending' })
    await seedEntry(db, taskId, {
      originNodeRunId: legacyOrigin,
      sourceKind: 'manual', // → resolveEntryShardKeys returns null
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: legacyRerun,
    })

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryB.id], actor)
    } catch (e) {
      threw = e
    }
    // the null-shard legacy ledger is NOT skipped → it blocks (conservative, no double-mint).
    expect((threw as { code?: string }).code).toBe('task-question-node-dispatch-in-flight')
  })
})
