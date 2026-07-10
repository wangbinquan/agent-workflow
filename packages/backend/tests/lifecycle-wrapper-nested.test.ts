import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1f — loop / fan-out / wrapper nesting interactions.
//
// Locks key shape invariants for nested constructs:
//   - per-iteration scope: dispatch at iter=N considers only iter=N rows
//   - fan-out child rows (parentNodeRunId set) are excluded from top-level
//     selection and dispatch
//   - iterate at iter=N mints upstream retry at iter=N, NOT iter=N-1
//
// Full scheduler e2e for these patterns is covered in
// scheduler-rfc040-wrapper-await.test.ts and friends; this file pins the
// shape-level invariants the refactor must not break.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { dispatchReviewNode, submitReviewDecision } from '../src/services/review'
import { isFresherNodeRun } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  definition: WorkflowDefinition
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1f-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
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
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
      {
        id: 'wrap_loop',
        kind: 'wrapper-loop',
        nodeIds: ['doc', 'rev_1'],
        maxIterations: 3,
        exitCondition: { kind: 'port-empty', portRef: { nodeId: 'doc', portName: 'docpath' } },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    repoPath,
    taskId,
    definition,
    cleanup: () => rimrafDir(tmp),
  }
}

describe('RFC-053 PR-A T1f — loop / fan-out / wrapper nesting', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('W1 iter scope — dispatch at iter=1 ignores iter=0 done rows', async () => {
    // iter=0: full pass done (agent + review approved)
    const iter0Agent = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter0Agent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 900,
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: iter0Agent, portName: 'docpath', content: '# v0' })
    const iter0Review = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter0Review,
      taskId: h.taskId,
      nodeId: 'rev_1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now() - 800,
      finishedAt: Date.now() - 700,
    })

    // iter=1: agent re-ran with new content; review pending.
    const iter1Agent = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter1Agent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 1,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: iter1Agent, portName: 'docpath', content: '# v1' })

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 1,
    })
    expect(res.kind).toBe('awaiting_review')

    // iter=0 row untouched.
    const iter0After = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, iter0Review)))[0]!
    expect(iter0After.status).toBe('done')
    expect(iter0After.iteration).toBe(0)

    // New iter=1 review row created.
    const iter1Rows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_1')))
    const iter1Row = iter1Rows.find((r) => r.iteration === 1)
    expect(iter1Row).toBeDefined()
    expect(iter1Row!.status).toBe('awaiting_review')

    // Doc_version v1 minted at iter=1.
    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, iter1Row!.id))
    expect(dvs.length).toBe(1)
  })

  test('W2 iter scope — iterate at iter=1 mints upstream retry at iter=1, leaves iter=0 alone', async () => {
    const iter0Agent = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter0Agent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 900,
    })
    const iter1Agent = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter1Agent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 1,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: iter1Agent, portName: 'docpath', content: '# v1' })

    const reviewRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId: h.taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 1,
      reviewIteration: 0,
      startedAt: Date.now() - 30,
    })
    mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
    writeFileSync(join(h.appHome, 'doc_versions', 'v1.md'), '# v1')
    await h.db.insert(docVersions).values({
      id: ulid(),
      taskId: h.taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'pending',
    })

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'tester',
    })

    // iter=0 agent row untouched.
    const iter0After = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, iter0Agent)))[0]!
    expect(iter0After.status).toBe('done')

    // iter=1 has TWO doc rows now: original (canceled supersede) + retry=1 (pending).
    const agentRowsIter1 = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'doc'))
    ).filter((r) => r.iteration === 1)
    expect(agentRowsIter1.length).toBe(2)
    const fresh = agentRowsIter1.find((r) => r.retryIndex === 1)
    expect(fresh).toBeDefined()
    expect(fresh!.status).toBe('pending')
    expect(fresh!.iteration).toBe(1)
  })

  test('W3 fan-out child rows are excluded from latestPerNode (parentNodeRunId set)', async () => {
    // Simulate an agent-multi fan-out: parent row done + N children done.
    const parent = ulid()
    await h.db.insert(nodeRuns).values({
      id: parent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    for (let i = 0; i < 3; i++) {
      await h.db.insert(nodeRuns).values({
        id: ulid(),
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'done',
        retryIndex: i + 1, // children with higher retry — would beat parent if not for parentNodeRunId guard
        iteration: 0,
        parentNodeRunId: parent,
        shardKey: `shard-${i}`,
        startedAt: Date.now() - 400,
        finishedAt: Date.now() - 300,
      })
    }

    const rows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    // Mimic scheduler.runScope latestPerNode logic (parentNodeRunId guard).
    let latest: (typeof rows)[number] | undefined
    for (const r of rows) {
      if (r.iteration !== 0) continue
      if (r.parentNodeRunId !== null) continue
      if (isFresherNodeRun(r, latest)) latest = r
    }
    expect(latest!.id).toBe(parent)
  })

  test('W4 fan-out child rows ignored by dispatchReviewNode upstream selection', async () => {
    // Parent done with docpath output; phantom child with retry=99 but
    // parentNodeRunId set. dispatchReviewNode must pick parent.
    const parent = ulid()
    await h.db.insert(nodeRuns).values({
      id: parent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: parent, portName: 'docpath', content: '# parent body' })

    const child = ulid()
    await h.db.insert(nodeRuns).values({
      id: child,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 99,
      iteration: 0,
      parentNodeRunId: parent,
      shardKey: 'shard-x',
      startedAt: Date.now() - 400,
      finishedAt: Date.now() - 300,
    })
    // Child has NO docpath output — only parent does. If dispatch picked
    // child, it would fail with review-source-port-missing.

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    // If dispatch wrongly picked child it would be 'failed'; correct
    // selection of parent yields 'awaiting_review' (or 'ok' if any-done
    // short-circuit — no review rows exist yet, so it's awaiting_review).
    expect(res.kind).toBe('awaiting_review')

    void child
  })

  test('W5 dispatching review at iter=2 spawns iter=2 doc_version + node_run, leaves iter=0/1 doc_versions intact', async () => {
    // Seed: each iter has its own agent done row + review done + approved doc_version.
    for (const iter of [0, 1]) {
      const a = ulid()
      await h.db.insert(nodeRuns).values({
        id: a,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'done',
        retryIndex: 0,
        iteration: iter,
        startedAt: Date.now() - 1000,
        finishedAt: Date.now() - 900,
      })
      await h.db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: a, portName: 'docpath', content: `# iter-${iter}` })
      const rv = ulid()
      await h.db.insert(nodeRuns).values({
        id: rv,
        taskId: h.taskId,
        nodeId: 'rev_1',
        status: 'done',
        retryIndex: 0,
        iteration: iter,
        reviewIteration: 0,
        startedAt: Date.now() - 800,
        finishedAt: Date.now() - 700,
      })
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', `iter${iter}.md`), `# iter-${iter}`)
      await h.db.insert(docVersions).values({
        id: ulid(),
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: rv,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: `doc_versions/iter${iter}.md`,
        decision: 'approved',
        decidedAt: Date.now() - 600,
      })
    }
    // iter=2: agent done, no review yet
    const iter2Agent = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter2Agent,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 2,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await h.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: iter2Agent, portName: 'docpath', content: '# iter-2' })

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 2,
    })
    expect(res.kind).toBe('awaiting_review')

    // iter=0 and iter=1 doc_versions unchanged.
    const allDvs = await h.db.select().from(docVersions).where(eq(docVersions.taskId, h.taskId))
    const approvedCount = allDvs.filter((d) => d.decision === 'approved').length
    expect(approvedCount).toBe(2)
    const pendingCount = allDvs.filter((d) => d.decision === 'pending').length
    expect(pendingCount).toBe(1)
  })
})
