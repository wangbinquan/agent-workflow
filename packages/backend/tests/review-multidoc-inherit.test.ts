import { rimrafDir } from './helpers/cleanup'
// RFC-129 — multi-document review cross-round selection inheritance (integration).
//
// WHY THIS FILE EXISTS (regression intent, proposal AC-1..AC-12):
//   - iterate/reject re-open → next round inherits the prior round's per-doc
//     selection (AC-1/AC-7); a carried doc whose content changed is stale-flagged
//     (AC-4), content-unchanged is not (AC-4), unselected carries nothing.
//   - a human re-marking the current content clears stale (AC-6).
//   - single-document review is untouched: selection_stale stays NULL (AC-9).
//   - inheritance is scoped to one workflow iteration — a different loop pass does
//     not inherit (AC-10).
// Codex design-gate P1 lock: the prior round lives on the SAME reused review
// node_run (iterate/reject) — inheritance must still find it (not exclude it).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  dispatchReviewNode,
  setDocumentSelection,
  submitReviewDecision,
} from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const PATHS = ['cases/a.md', 'cases/b.md', 'cases/c.md']

describe('RFC-129 — cross-round selection inheritance', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc129-'))
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

  async function seed(upstreamKind: string): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    await db.insert(agentsTable).values({
      id: ulid(),
      name: 'caseGen',
      description: '',
      outputs: JSON.stringify(['cases']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: JSON.stringify({ outputKinds: { cases: upstreamKind } }),
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'src',
          kind: 'agent-single',
          agentName: 'caseGen',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'cases' },
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
      id: taskId,
      name: 'multidoc',
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
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  /** Complete a fresh (pending) src run: mark done, emit `cases`, write files. */
  async function completeSrc(
    taskId: string,
    runId: string,
    paths: string[],
    body: (p: string) => string,
    iteration = 0,
  ): Promise<void> {
    const existing = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    if (existing === undefined) {
      await db.insert(nodeRuns).values({
        id: runId,
        taskId,
        nodeId: 'src',
        status: 'done',
        retryIndex: 0,
        iteration,
        preSnapshot: null,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
    } else {
      await db
        .update(nodeRuns)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, runId))
    }
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: runId, portName: 'cases', content: paths.join('\n') })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: paths.join('\n') },
      })
    for (const p of paths) {
      const abs = join(worktree, p)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body(p), 'utf8')
    }
  }

  /** The freshest pending src run minted by an iterate/reject decision. */
  async function freshPendingSrc(taskId: string): Promise<string> {
    const runs = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, 'src'),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    runs.sort((a, b) => (a.id < b.id ? 1 : -1))
    return runs[0]!.id
  }

  async function docsFor(taskId: string): Promise<(typeof docVersions.$inferSelect)[]> {
    return db
      .select()
      .from(docVersions)
      .where(eq(docVersions.taskId, taskId))
      .orderBy(docVersions.itemIndex)
  }

  async function dispatch(
    ctx: {
      taskId: string
      task: typeof tasks.$inferSelect
      definition: WorkflowDefinition
      reviewNode: WorkflowNode
    },
    iteration = 0,
  ): Promise<void> {
    const r = await dispatchReviewNode({
      db,
      taskId: ctx.taskId,
      task: ctx.task,
      appHome,
      definition: ctx.definition,
      node: ctx.reviewNode,
      iteration,
    })
    if (r.kind !== 'awaiting_review') throw new Error(`dispatch → ${JSON.stringify(r)}`)
    expect(r.kind).toBe('awaiting_review')
  }

  // Round-1 content: a.md CHANGED, b.md SAME as round 0, c.md SAME.
  const round0Body = (p: string) => `# Case ${p}\n\noriginal steps for ${p}\n`
  const round1Body = (p: string) =>
    p === 'cases/a.md' ? `# Case ${p}\n\nREVISED steps\n` : round0Body(p)

  test('iterate re-opens with prior selections inherited + stale flag (AC-1/AC-4; Codex P1 same-run)', async () => {
    const ctx = await seed('list<path<md>>')
    await completeSrc(ctx.taskId, ulid(), PATHS, round0Body)
    await dispatch(ctx)
    const r0 = await docsFor(ctx.taskId)
    const runId = r0[0]!.reviewNodeRunId
    // a=accepted, b=not_accepted, c left unselected (iterate allows partial).
    await setDocumentSelection({
      db,
      nodeRunId: runId,
      docVersionId: r0[0]!.id,
      selection: 'accepted',
    })
    await setDocumentSelection({
      db,
      nodeRunId: runId,
      docVersionId: r0[1]!.id,
      selection: 'not_accepted',
    })

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: runId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    // Simulate the scheduler running the re-minted upstream with new content.
    await completeSrc(ctx.taskId, await freshPendingSrc(ctx.taskId), PATHS, round1Body)
    await dispatch(ctx)

    // Round-1 members = highest reviewIteration.
    const all = await docsFor(ctx.taskId)
    const round1 = all
      .filter((d) => d.reviewIteration === 1)
      .sort((a, b) => a.itemIndex! - b.itemIndex!)
    expect(round1.length).toBe(3)
    // a.md: inherit accepted; content CHANGED → stale.
    expect(round1[0]!.selection).toBe('accepted')
    expect(round1[0]!.selectionStale).toBe(true)
    // b.md: inherit not_accepted; content SAME → not stale.
    expect(round1[1]!.selection).toBe('not_accepted')
    expect(round1[1]!.selectionStale).toBe(false)
    // c.md: was unselected → unselected, not stale.
    expect(round1[2]!.selection).toBe('unselected')
    expect(round1[2]!.selectionStale).toBe(false)
    // and the prior round is preserved with its decision.
    const round0 = all.filter((d) => d.reviewIteration === 0)
    expect(round0.every((d) => d.decision === 'iterated')).toBe(true)
  })

  test('reject re-opens with prior selections inherited too (AC-7)', async () => {
    const ctx = await seed('list<path<md>>')
    await completeSrc(ctx.taskId, ulid(), PATHS, round0Body)
    await dispatch(ctx)
    const r0 = await docsFor(ctx.taskId)
    const runId = r0[0]!.reviewNodeRunId
    await setDocumentSelection({
      db,
      nodeRunId: runId,
      docVersionId: r0[0]!.id,
      selection: 'accepted',
    })

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: runId,
      decision: 'rejected',
      rejectReason: 'redo',
      expectedReviewIteration: 0,
    })
    await completeSrc(ctx.taskId, await freshPendingSrc(ctx.taskId), PATHS, round1Body)
    await dispatch(ctx)

    const round1 = (await docsFor(ctx.taskId))
      .filter((d) => d.reviewIteration === 1)
      .sort((a, b) => a.itemIndex! - b.itemIndex!)
    expect(round1[0]!.selection).toBe('accepted') // inherited across reject
    expect(round1[0]!.selectionStale).toBe(true) // a.md content changed
  })

  test('a human re-marking the current content clears stale (AC-6)', async () => {
    const ctx = await seed('list<path<md>>')
    await completeSrc(ctx.taskId, ulid(), PATHS, round0Body)
    await dispatch(ctx)
    const r0 = await docsFor(ctx.taskId)
    const runId = r0[0]!.reviewNodeRunId
    await setDocumentSelection({
      db,
      nodeRunId: runId,
      docVersionId: r0[0]!.id,
      selection: 'accepted',
    })
    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: runId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    await completeSrc(ctx.taskId, await freshPendingSrc(ctx.taskId), PATHS, round1Body)
    await dispatch(ctx)

    const round1 = (await docsFor(ctx.taskId))
      .filter((d) => d.reviewIteration === 1)
      .sort((a, b) => a.itemIndex! - b.itemIndex!)
    const aDoc = round1[0]!
    expect(aDoc.selectionStale).toBe(true)
    await setDocumentSelection({
      db,
      nodeRunId: aDoc.reviewNodeRunId,
      docVersionId: aDoc.id,
      selection: 'accepted',
    })
    const after = (await db.select().from(docVersions).where(eq(docVersions.id, aDoc.id)))[0]!
    expect(after.selectionStale).toBe(false)
  })

  test('single-document review is untouched — selection_stale stays NULL (AC-9 golden)', async () => {
    const ctx = await seed('markdown_file') // single-doc mode (not a list)
    await completeSrc(ctx.taskId, ulid(), ['cases/a.md'], round0Body)
    await dispatch(ctx)
    const r0 = await docsFor(ctx.taskId)
    expect(r0.length).toBe(1)
    expect(r0[0]!.itemIndex).toBeNull()
    expect(r0[0]!.selectionStale).toBeNull()

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: r0[0]!.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    await completeSrc(ctx.taskId, await freshPendingSrc(ctx.taskId), ['cases/a.md'], round1Body)
    await dispatch(ctx)
    const all = await docsFor(ctx.taskId)
    expect(all.every((d) => d.itemIndex === null && d.selectionStale === null)).toBe(true)
  })

  test('inheritance does not cross workflow iterations (AC-10 loop isolation)', async () => {
    const ctx = await seed('list<path<md>>')
    // Iteration 0: a decided round (selections set), left as-is.
    await completeSrc(ctx.taskId, ulid(), PATHS, round0Body, 0)
    await dispatch(ctx, 0)
    const r0 = await docsFor(ctx.taskId)
    await setDocumentSelection({
      db,
      nodeRunId: r0[0]!.reviewNodeRunId,
      docVersionId: r0[0]!.id,
      selection: 'accepted',
    })

    // Iteration 1 (a fresh loop pass): its own src run + review dispatch.
    await completeSrc(ctx.taskId, ulid(), PATHS, round1Body, 1)
    await dispatch(ctx, 1)
    const iter1 = (await docsFor(ctx.taskId)).filter(
      (d) => d.reviewNodeRunId !== r0[0]!.reviewNodeRunId,
    )
    // None inherit iteration-0's accepted — a new loop pass starts clean.
    expect(iter1.length).toBe(3)
    // A new loop pass starts clean — no selection carried from iteration 0.
    expect(iter1.every((d) => d.selection === 'unselected')).toBe(true)
    expect(iter1.every((d) => d.selectionStale === false)).toBe(true)
  })

  test('a re-added document does NOT resurrect an older generation (Codex impl-gate P2)', async () => {
    const ctx = await seed('list<path<md>>')
    // Simulate a refresh that left TWO generations on the SAME review run at the
    // SAME reviewIteration: gen1 [a,b,c] (older, round_generation 1000), gen2
    // [a,b] (newer, 2000, dropped c). A newest-per-item_index merge would keep
    // gen1's orphan c and let a re-added c inherit it — the P2 bug.
    const revRun = ulid()
    await db.insert(nodeRuns).values({
      id: revRun,
      taskId: ctx.taskId,
      nodeId: 'rev_1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    const seedDoc = async (
      gen: number,
      itemIndex: number,
      itemPath: string,
      selection: 'accepted' | 'not_accepted',
      decision: 'superseded' | 'iterated',
    ): Promise<void> => {
      const bodyPath = `runs/g${gen}-i${itemIndex}.md`
      mkdirSync(dirname(join(appHome, bodyPath)), { recursive: true })
      writeFileSync(join(appHome, bodyPath), `body g${gen} ${itemPath}`, 'utf8')
      await db.insert(docVersions).values({
        id: ulid(),
        taskId: ctx.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: revRun,
        sourceNodeId: 'src',
        sourcePortName: 'cases',
        versionIndex: gen,
        reviewIteration: 0,
        bodyPath,
        commentsJson: '[]',
        decision,
        itemIndex,
        selection,
        itemPath,
        selectionStale: false,
        roundGeneration: gen === 1 ? 1000 : 2000,
      })
    }
    // gen1 (older): a=accepted, b=not_accepted, c=accepted.
    await seedDoc(1, 0, 'cases/a.md', 'accepted', 'superseded')
    await seedDoc(1, 1, 'cases/b.md', 'not_accepted', 'superseded')
    await seedDoc(1, 2, 'cases/c.md', 'accepted', 'superseded')
    // gen2 (newer, immediately-previous): a=not_accepted, b=accepted. c DROPPED.
    await seedDoc(2, 0, 'cases/a.md', 'not_accepted', 'iterated')
    await seedDoc(2, 1, 'cases/b.md', 'accepted', 'iterated')

    // Fresh upstream re-adds c → new round [a,b,c].
    await completeSrc(ctx.taskId, ulid(), PATHS, round0Body)
    await dispatch(ctx)

    const gen3 = (await docsFor(ctx.taskId))
      .filter((d) => d.decision === 'pending')
      .sort((a, b) => a.itemIndex! - b.itemIndex!)
    expect(gen3.length).toBe(3)
    // a,b inherit gen2 (the immediately-previous generation), NOT gen1.
    expect(gen3[0]!.selection).toBe('not_accepted') // gen2 a, not gen1's accepted
    expect(gen3[1]!.selection).toBe('accepted') // gen2 b
    // c was absent from gen2 → treated as new → unselected (gen1's accepted NOT resurrected).
    expect(gen3[2]!.selection).toBe('unselected')
  })
})
