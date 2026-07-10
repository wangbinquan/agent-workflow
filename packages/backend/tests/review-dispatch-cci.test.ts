import { rimrafDir } from './helpers/cleanup'
// RFC-056 patch 2026-05-26 — review dispatch must respect clarifyIteration.
//
// Symptom (live task 01KS86DPCSERV7S41GQA5Y81RN, fifth visit on the same
// workflow `01KS7C0K5ZRJ29AZD7J13C42C2` "跨节点反问"): designer agent_m7p3n1
// re-runs cleanly after each cross-clarify resolve at bumped cci, but the
// reviewer rev_5h9xpz never runs at cci > 0. b48d63 (questioner agent
// downstream of the reviewer) keeps reading the same first-iteration
// approved_doc and quietly diverging from the doc agent_m7p3n1 has been
// rewriting.
//
// Root cause: `dispatchReviewNode` line 418-427 (pre-patch) short-circuited
// to `kind: 'ok'` the moment ANY top-level done row existed for that review
// at that iteration — regardless of clarifyIteration. So every
// cascade-minted pending review row at cci=N was silently treated as
// "already approved" by the scheduler and never dispatched.
//
// This file locks the patch's three contracts:
//   1. Unit tests for the new exported helpers `pickFreshestReviewRun` and
//      `isReviewClarifyAlignedWithUpstream`. The helpers are the single source
//      of truth for short-circuit logic.
//   2. Behavioural tests for the cci-aware short-circuit (alignment true =
//      short-circuit fires verbatim like RFC-052 / alignment false =
//      cascade pending row reparks as awaiting_review).
//   3. Source-text guards: review.ts uses the helper, the literal token
//      `alreadyDone` does NOT survive, and the patch md exists. If any of
//      these go red the cci-aware short-circuit drifted; investigate before
//      relaxing.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode, pickFreshestReviewRun } from '../src/services/review'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const REVIEW_SOURCE_PATH = resolve(import.meta.dir, '..', 'src', 'services', 'review.ts')
const PATCH_MD_PATH = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'design',
  'RFC-056-clarify-cross-agent',
  'patch-2026-05-26-review-dispatch-respects-cci.md',
)

// ---------------------------------------------------------------------------
// Tiny row builders for the pure-helper unit tests. They typecheck against
// `typeof nodeRuns.$inferSelect` so we hand-roll a minimal-yet-valid row.
// ---------------------------------------------------------------------------

function row(
  partial: Partial<typeof nodeRuns.$inferSelect> & { id: string; status: string },
): typeof nodeRuns.$inferSelect {
  return {
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    reviewIteration: 0,
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    tokTotal: null,
    preSnapshot: null,
    opencodeSessionId: null,
    inventorySnapshotJson: null,
    wrapperProgressJson: null,
    injectedMemoriesJson: null,
    portValidationFailuresJson: null,
    taskId: 't',
    nodeId: 'review',
    ...partial,
  } as unknown as typeof nodeRuns.$inferSelect
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 patch-2026-05-26 — pickFreshestReviewRun', () => {
  test('returns undefined for both when input is empty', () => {
    const { reuse, latestDone } = pickFreshestReviewRun([])
    expect(reuse).toBeUndefined()
    expect(latestDone).toBeUndefined()
  })

  test('skips fan-out child rows (parentNodeRunId != null)', () => {
    const top = row({ id: 'top', status: 'pending', retryIndex: 0 })
    const child = row({ id: 'child', status: 'done', retryIndex: 5, parentNodeRunId: 'top' })
    const { reuse, latestDone } = pickFreshestReviewRun([top, child])
    expect(reuse?.id).toBe('top')
    // Child must NOT bubble into latestDone — fan-out aggregation is
    // dispatchReviewNode T14's job, not this helper's.
    expect(latestDone).toBeUndefined()
  })

  test('reuse = freshest by isFresherNodeRun (pure ULID id-order)', () => {
    // Causal ids: the pending rerun was minted after the old done row.
    const oldDone = row({ id: '01-old', status: 'done', retryIndex: 0 })
    const newPending = row({ id: '02-new', status: 'pending', retryIndex: 1 })
    const { reuse } = pickFreshestReviewRun([oldDone, newPending])
    expect(reuse?.id).toBe('02-new')
  })

  test('latestDone tracks the freshest done row independently of reuse', () => {
    const doneAtR0 = row({ id: 'd0', status: 'done', retryIndex: 0 })
    const doneAtR2 = row({ id: 'd2', status: 'done', retryIndex: 2 })
    const pendingAtR3 = row({ id: 'p3', status: 'pending', retryIndex: 3 })
    const { reuse, latestDone } = pickFreshestReviewRun([doneAtR0, doneAtR2, pendingAtR3])
    expect(reuse?.id).toBe('p3')
    expect(latestDone?.id).toBe('d2')
  })

  test('latestDone returns undefined when all rows are non-done', () => {
    const p1 = row({ id: 'p1', status: 'pending', retryIndex: 1 })
    const p2 = row({ id: 'p2', status: 'awaiting_review', retryIndex: 2 })
    const { reuse, latestDone } = pickFreshestReviewRun([p1, p2])
    expect(reuse?.id).toBe('p2')
    expect(latestDone).toBeUndefined()
  })
})

// RFC-074 PR-C: the `isReviewClarifyAlignedWithUpstream` cci short-circuit was
// deleted (PR-B). The "prior approval still covers the upstream → skip / fire
// re-review" decision is now provenance-based (`coversSource` on the consumed
// run id), exercised by the dispatchReviewNode integration tests below
// (especially "stale provenance → US-2 re-review").

// ---------------------------------------------------------------------------
// dispatchReviewNode integration — alignment true short-circuits, false
// reparks the pending row as awaiting_review.
// ---------------------------------------------------------------------------

describe('RFC-056 patch-2026-05-26 — dispatchReviewNode cci-aware short-circuit', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-cci-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rimrafDir(appHome)
    rimrafDir(worktree)
  })

  async function seed(): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    const agentId = ulid()
    await db.insert(agentsTable).values({
      id: agentId,
      name: 'designer',
      description: '',
      outputs: JSON.stringify(['docpath']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'designer',
          kind: 'agent-single',
          agentName: 'designer',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'docpath' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'cci-fixture',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev')!
    return { taskId, task, definition, reviewNode }
  }

  test('alignment TRUE (latestDone.cci >= upstream.cci) → kind: ok, no side-effect', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    // Upstream designer done at cci=0.
    const designerRunId = ulid()
    await db.insert(nodeRuns).values({
      id: designerRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerRunId,
      portName: 'docpath',
      content: '# inline body',
    })
    // Review done at cci=0 — RFC-052 baseline.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'rev',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('ok')
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'rev')))
    expect(reviewRows.length).toBe(1)
    expect(reviewRows[0]?.status).toBe('done')
  })

  // RFC-074: superseded the cci-alignment + cascade-repark mechanism this test
  // originally locked (a cascade pre-minted a pending review row; dispatch
  // reparked it). Cascades are gone — re-review on a genuinely-advanced upstream
  // is now driven by PROVENANCE: a done review that consumed an OLDER source
  // run is stale when the source produces a fresher run, so dispatch mints a
  // fresh awaiting_review (RFC-005 US-2). This rewrite asserts that behavior.
  test('stale provenance: review consumed an older source → US-2 re-review (fresh awaiting_review)', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    // Old designer done — the version the prior review approved. RFC-074 PR-C:
    // freshness is pure id-order, so ids are CAUSAL (new minted after old).
    const oldDesignerId = '01A_OLD_DESIGNER'
    await db.insert(nodeRuns).values({
      id: oldDesignerId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 5000,
      finishedAt: Date.now() - 4000,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: oldDesignerId,
      portName: 'docpath',
      content: '# original body',
    })
    // Fresher designer done (e.g. a later rerun) — this is the current source.
    const newDesignerId = '01B_NEW_DESIGNER'
    await db.insert(nodeRuns).values({
      id: newDesignerId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: newDesignerId,
      portName: 'docpath',
      content: '# updated body',
    })
    // Prior review done that CONSUMED the old designer run (stale provenance).
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'rev',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      consumedUpstreamRunsJson: JSON.stringify({ designer: oldDesignerId }),
      startedAt: Date.now() - 5000,
      finishedAt: Date.now() - 4000,
    })

    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    // Upstream advanced past what the review consumed → fresh re-review opens.
    expect(result.kind).toBe('awaiting_review')
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'rev')))
    const fresh = reviewRows.find((r) => r.status === 'awaiting_review')
    expect(fresh).toBeDefined()
    // The fresh review row records consuming the NEW designer run.
    expect(JSON.parse(fresh!.consumedUpstreamRunsJson ?? '{}').designer).toBe(newDesignerId)
    // A v1 doc_version on the new review row was created against the updated body.
    const versions = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, fresh!.id))
    expect(versions.length).toBe(1)
    expect(versions[0]?.decision).toBe('pending')
  })

  test('RFC-052 regression guard: cci=0 single done + placeholder pending still short-circuits', async () => {
    // Workflow that never sees cross-clarify must not regress.
    const { taskId, task, definition, reviewNode } = await seed()
    const designerRunId = ulid()
    await db.insert(nodeRuns).values({
      id: designerRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerRunId,
      portName: 'docpath',
      content: '# body',
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'rev',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    const stuckId = ulid()
    await db.insert(nodeRuns).values({
      id: stuckId,
      taskId,
      nodeId: 'rev',
      status: 'pending',
      retryIndex: 1,
      iteration: 0,
    })

    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('ok')
    const stuck = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, stuckId)).limit(1))[0]
    expect(stuck?.status).toBe('pending')
  })

  test('No done review row at all → not short-circuited (must dispatch fresh)', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    const designerRunId = ulid()
    await db.insert(nodeRuns).values({
      id: designerRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerRunId,
      portName: 'docpath',
      content: '# body',
    })
    // No prior review rows.

    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'rev')))
    expect(reviewRows.length).toBe(1)
    expect(reviewRows[0]?.status).toBe('awaiting_review')
  })
})

// ---------------------------------------------------------------------------
// Source-text guards — the helper-only short-circuit must survive future
// refactors. Each guard fails fast with a clear redirect to this patch md.
// ---------------------------------------------------------------------------

describe('RFC-056 patch-2026-05-26 — source-text guards', () => {
  const src = readFileSync(REVIEW_SOURCE_PATH, 'utf8')

  test('review.ts exports pickFreshestReviewRun; the cci helper is gone (RFC-074 PR-C)', () => {
    expect(src).toContain('export function pickFreshestReviewRun(')
    // PR-C deleted the cci-alignment short-circuit entirely.
    expect(src.includes('isReviewClarifyAlignedWithUpstream')).toBe(false)
  })

  test('RFC-074: dispatchReviewNode uses provenance (coversSource), not a cci-aware helper', () => {
    // The re-review decision flows through coversSource + the recorded
    // consumed_upstream_runs_json — never a clarifyIteration comparison.
    expect(src).toContain('coversSource')
    expect(src).toContain('consumedUpstreamRunsJson')
    // No LIVE clarifyIteration usage (prose comments referencing the retired
    // counter are fine; property access / object-key assignment are not).
    expect(/\.clarifyIteration\b/.test(src)).toBe(false)
    expect(/\bclarifyIteration\s*:/.test(src)).toBe(false)
    // The pre-patch literal must NOT survive either.
    expect(src.includes('let alreadyDone =')).toBe(false)
    expect(src.includes('alreadyDone = true')).toBe(false)
  })

  test('patch md exists and references the cci-aware short-circuit contract', () => {
    const md = readFileSync(PATCH_MD_PATH, 'utf8')
    expect(md).toContain('patch 2026-05-26')
    // RFC-064 renamed the helper to `isReviewClarifyAlignedWithUpstream`;
    // the patch md is a historical audit trail and still uses the original
    // `isReviewCciAlignedWithUpstream` spelling. Accept either form so the
    // historical record stays intact while the rename lock remains
    // enforceable for live source via the test above.
    expect(
      md.includes('isReviewClarifyAlignedWithUpstream') ||
        md.includes('isReviewCciAlignedWithUpstream'),
    ).toBe(true)
    expect(md).toContain('pickFreshestReviewRun')
    expect(md).toContain('01KS86DPCSERV7S41GQA5Y81RN')
  })
})
