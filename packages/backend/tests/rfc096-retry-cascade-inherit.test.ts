import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-096 (audit S-13 / 附录 C #2, design §3.2) — retryNode cascade
// inheritance source + conservative nextRetry.
//
// retryNode (task.ts) flips the user-picked node and every
// retryCascade='mint-placeholder' downstream node to a fresh `failed` row
// ('queued for retry') the resume scheduler treats as latest. For cascaded
// downstream nodes the placeholder INHERITS (iteration, reviewIteration,
// shardKey, parentNodeRunId, preSnapshot) from a prior row of that node.
//
// Before RFC-096 that prior row was picked with SQL
// `orderBy(desc(retryIndex)).limit(1)` over ALL rows of the node — no
// parent-row filter, no id order (verified against the pre-RFC-096 code at
// HEAD). A fan-out shard CHILD row with an inflated retryIndex therefore
// hijacked the inheritance: the placeholder landed with a non-null
// parentNodeRunId — INVISIBLE to deriveFrontier (it skips child rows), so the
// cascade was silently dead for the frontier — plus the child's stale
// iteration and shardKey.
//
// RFC-096 fix (red → green here):
//   - inheritance source = pickFreshestRun(existing, { topLevelOnly: true })
//     — pure ULID id order over TOP-LEVEL rows only; status deliberately NOT
//     filtered (the freshest top-level row anchors the frame whatever its
//     status, same shape as applyReviewDecision's supersede pick).
//   - nextRetry stays the CONSERVATIVE all-rows max+1 (child rows INCLUDED):
//     the old picker itself could mint pathological rows whose child/inherited
//     retryIndex exceeds every top-level row, so `prev.retryIndex + 1` could
//     collide with existing (nodeId, retryIndex) frames on legacy DBs. The
//     conservative口径 can never collide.
//   - prev === undefined (a fanout-inner node with ONLY child rows) keeps the
//     `?? 0` fallback: the placeholder lands as a fresh iteration-0 TOP-LEVEL
//     failed row, which is INERT for the top-level scope (the inner node is
//     not in the top scope; wrapper re-dispatch goes through its own resume /
//     priorChildren path) — design §3.2's laziness argument, locked as
//     current behavior in test 2.
//
// Harness mirrors retry-cascade-kind-matrix.test.ts (real retryNode entry)
// with the s22 simplification (plain-dir worktree + preSnapshot=null on the
// retried target row ⇒ rollbackNodeRunForResume is a no-op, no git needed).
// The workflow's agentName is deliberately NOT seeded in `agents`: retryNode's
// tail `void runTask` fails fast on agent lookup (scheduler.ts
// 'agent-not-found'), and each test waits for the terminal task state so no
// background work outlives the test. Placeholder rows are identified by
// errorMessage === 'queued for retry', which only retryNode writes — the
// background scheduler can only ADD differently-marked rows, never touch
// these.
//
// Seeded run ids use a monotonicFactory ULID (seeding order = causal order =
// id order, the invariant production ULIDs provide); a ≥2ms sleep before
// retryNode guarantees the production-minted placeholder id sorts strictly
// above every seeded id (fresh time component).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc096-retry-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}

/** up → down two-node graph; both agent-single (retryCascade='mint-placeholder'). */
function twoNodeDef(downId: string): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'up', kind: 'agent-single', agentName: 'nope-agent', promptTemplate: '' },
      { id: downId, kind: 'agent-single', agentName: 'nope-agent', promptTemplate: '' },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'up', portName: 'out' },
        target: { nodeId: downId, portName: 'in' },
      },
    ],
  } as unknown as WorkflowDefinition
}

function singleNodeDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'up', kind: 'agent-single', agentName: 'nope-agent', promptTemplate: '' }],
    edges: [],
  } as unknown as WorkflowDefinition
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf-rfc096-retry',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    name: 't-rfc096-retry',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/nonexistent-rfc096-repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'failed',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    errorSummary: 'boom',
  })
  return taskId
}

// retryNode 尾部后台 void runTask（agent 未播种 → 'agent-not-found' 快速失败）。
// 等任务离开 pending/running 再让测试结束，避免后台写竞速 afterEach 清理。
async function waitForTerminalTask(db: DbClient, taskId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    if (t !== undefined && t.status !== 'pending' && t.status !== 'running') return
    await Bun.sleep(25)
  }
  throw new Error(`task ${taskId} did not reach a terminal status within budget`)
}

const DEPS = (h: Harness) => ({
  db: h.db,
  appHome: h.appHome,
  opencodeCmd: ['/usr/bin/env', 'true'],
})

describe('RFC-096 §3.2 — retryNode cascade inheritance source (freshest TOP-LEVEL row)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('downstream row set = old top-level rows + newer fan-out child (higher retryIndex & id) → placeholder inherits the freshest TOP-LEVEL frame, retryIndex = all-rows max+1 (red before fix)', async () => {
    const taskId = await seedTask(h, twoNodeDef('down'))

    // Target (user-picked) row on 'up' — preSnapshot null ⇒ rollback no-op.
    const upRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: upRunId,
      taskId,
      nodeId: 'up',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 800,
    })

    // 'down' row set — three generations, ids strictly increasing (monotonic):
    // (1) stale top-level failed row.
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'down',
      status: 'failed',
      retryIndex: 1,
      iteration: 0,
      reviewIteration: 0,
      preSnapshot: 'stash-old',
      startedAt: Date.now() - 700,
      finishedAt: Date.now() - 650,
    })
    // (2) the freshest TOP-LEVEL row — the CORRECT inheritance source. Its
    // iteration / reviewIteration / preSnapshot differ from every other row so
    // each inherited field discriminates the pick.
    const downTopId = ulid()
    await h.db.insert(nodeRuns).values({
      id: downTopId,
      taskId,
      nodeId: 'down',
      status: 'done',
      retryIndex: 2,
      iteration: 1,
      reviewIteration: 2,
      preSnapshot: 'stash-top',
      startedAt: Date.now() - 600,
      finishedAt: Date.now() - 550,
    })
    // (3) fan-out shard CHILD row: newest id AND highest retryIndex — the old
    // `desc(retryIndex)` pick chose THIS row (red shape: placeholder inherited
    // parentNodeRunId='fanout-parent-run-1', iteration=0, reviewIteration=7,
    // shardKey='src/a.ts', preSnapshot='stash-child').
    const downChildId = ulid()
    await h.db.insert(nodeRuns).values({
      id: downChildId,
      taskId,
      nodeId: 'down',
      parentNodeRunId: 'fanout-parent-run-1',
      status: 'done',
      retryIndex: 5,
      iteration: 0,
      reviewIteration: 7,
      shardKey: 'src/a.ts',
      preSnapshot: 'stash-child',
      startedAt: Date.now() - 500,
      finishedAt: Date.now() - 450,
    })

    // ≥2ms gap: the production ulid() inside retryNode gets a strictly larger
    // time component than every seeded id (no same-ms random-order flake).
    await Bun.sleep(2)
    await retryNode(h.db, taskId, upRunId, { cascade: true, deps: DEPS(h) })

    const all = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))

    const downPlaceholders = all.filter(
      (r) => r.nodeId === 'down' && r.errorMessage === 'queued for retry',
    )
    expect(downPlaceholders).toHaveLength(1)
    const p = downPlaceholders[0]!
    // Inheritance frame = freshest TOP-LEVEL row (downTop), NOT the child:
    expect(p.parentNodeRunId).toBeNull() // red before fix: 'fanout-parent-run-1' → frontier-invisible
    expect(p.iteration).toBe(1) // red before fix: 0 (child's stale iteration)
    expect(p.reviewIteration).toBe(2) // red before fix: 7
    expect(p.shardKey).toBeNull() // red before fix: 'src/a.ts'
    expect(p.preSnapshot).toBe('stash-top') // red before fix: 'stash-child'
    expect(p.status).toBe('failed')
    // Conservative nextRetry: ALL-rows max (child's 5) + 1 — never collides
    // with legacy inflated child retryIndex. (The old code happened to land 6
    // too via the child pick; this pins the conservative口径 against a future
    // "top-level max+1" simplification, which would yield 3 here.)
    expect(p.retryIndex).toBe(6)
    // Freshest-by-id: the placeholder must outrank every seeded row so the
    // resume scheduler (pure id order) actually picks it up.
    expect(p.id > downChildId).toBe(true)

    // The user-picked target inherits from runRow itself; its nextRetry is
    // the node's own all-rows max+1 (only the retryIndex=0 row exists → 1).
    const upPlaceholders = all.filter(
      (r) => r.nodeId === 'up' && r.errorMessage === 'queued for retry',
    )
    expect(upPlaceholders).toHaveLength(1)
    expect(upPlaceholders[0]!.parentNodeRunId).toBeNull()
    expect(upPlaceholders[0]!.iteration).toBe(0)
    expect(upPlaceholders[0]!.retryIndex).toBe(1)

    await waitForTerminalTask(h.db, taskId)
  })

  test('prev === undefined laziness: downstream with ONLY fan-out child rows → placeholder is a fresh iteration-0 top-level failed row (design §3.2, current behavior lock)', async () => {
    // The pathological DB shape from production: a fanout-inner node that only
    // ever ran as shard children (parentNodeRunId non-null on every row). The
    // graph wires it via a direct edge so the cascade walk reaches it — only
    // the ROW shape matters for the prev-undefined branch under test.
    const taskId = await seedTask(h, twoNodeDef('inner'))

    const upRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: upRunId,
      taskId,
      nodeId: 'up',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 800,
    })
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'inner',
      parentNodeRunId: 'wrap-run-1',
      status: 'done',
      retryIndex: 2,
      iteration: 3,
      reviewIteration: 1,
      shardKey: 'f1.ts',
      preSnapshot: 'stash-c1',
      startedAt: Date.now() - 700,
      finishedAt: Date.now() - 650,
    })
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'inner',
      parentNodeRunId: 'wrap-run-1',
      status: 'failed',
      retryIndex: 4,
      iteration: 3,
      shardKey: 'f2.ts',
      startedAt: Date.now() - 600,
      finishedAt: Date.now() - 550,
    })

    await Bun.sleep(2)
    await retryNode(h.db, taskId, upRunId, { cascade: true, deps: DEPS(h) })

    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.nodeId === 'inner')
    expect(innerRows).toHaveLength(3) // 2 seeded children + 1 placeholder
    const placeholders = innerRows.filter((r) => r.errorMessage === 'queued for retry')
    expect(placeholders).toHaveLength(1)
    const p = placeholders[0]!
    // pickFreshestRun({topLevelOnly:true}) over child-only rows → undefined →
    // every inherited field falls back. Red before fix: the old desc(retryIndex)
    // pick chose the retryIndex=4 CHILD → parentNodeRunId='wrap-run-1',
    // iteration=3, shardKey='f2.ts'.
    expect(p.parentNodeRunId).toBeNull()
    expect(p.iteration).toBe(0) // lazy `?? 0` — NOT 3. The row is inert for the
    // top-level scope (inner node ∉ top scope; the wrapper re-runs its inner
    // subgraph via its own resume path) — design §3.2 deliberately keeps it.
    expect(p.reviewIteration).toBe(0)
    expect(p.shardKey).toBeNull()
    expect(p.preSnapshot).toBeNull()
    expect(p.status).toBe('failed')
    // nextRetry remains the conservative ALL-rows max+1 even when prev is
    // undefined — child retryIndex 4 + 1 (a `prev?.retryIndex+1 ?? 0`口径
    // would mint 0 and collide with... nothing today, but the conservative
    // promise is unconditional).
    expect(p.retryIndex).toBe(5)

    await waitForTerminalTask(h.db, taskId)
  })

  test('target-node nextRetry is conservative too: a pathological child row with inflated retryIndex lifts the placeholder above it (UNIQUE-frame collision guard)', async () => {
    const taskId = await seedTask(h, singleNodeDef())

    const upTopId = ulid()
    await h.db.insert(nodeRuns).values({
      id: upTopId,
      taskId,
      nodeId: 'up',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 800,
    })
    // Legacy pathological shape (mintable by the OLD pickers themselves, see
    // design §3.2 对抗检视 2b): a child row whose retryIndex exceeds every
    // top-level row.
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'up',
      parentNodeRunId: 'wrap-run-9',
      status: 'done',
      retryIndex: 7,
      iteration: 0,
      shardKey: 's.ts',
      startedAt: Date.now() - 700,
      finishedAt: Date.now() - 650,
    })

    await Bun.sleep(2)
    await retryNode(h.db, taskId, upTopId, { cascade: true, deps: DEPS(h) })

    const placeholders = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.nodeId === 'up' && r.errorMessage === 'queued for retry')
    expect(placeholders).toHaveLength(1)
    const p = placeholders[0]!
    // inherit = runRow (the user-picked TOP-LEVEL row), unchanged by RFC-096:
    expect(p.parentNodeRunId).toBeNull()
    expect(p.iteration).toBe(0)
    expect(p.shardKey).toBeNull()
    // ... but nextRetry = ALL-rows max+1 = 8, NOT runRow.retryIndex+1 = 1.
    // (Same value as the old desc(retryIndex) code — this is a口径 lock, not a
    // red→green: it pins the conservative promise so a future refactor to
    // `prev.retryIndex + 1` flips this test before it can collide on real DBs.)
    expect(p.retryIndex).toBe(8)

    await waitForTerminalTask(h.db, taskId)
  })
})
