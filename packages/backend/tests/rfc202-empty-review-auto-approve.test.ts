import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import type { TaskReadRow } from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { nodeRunFixtureColumns } from './helpers/model/nodeRun'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { withO2Closure } from './helpers/o2Closure'
// RFC-202 T1 — empty-list multi-doc review rounds auto-approve at dispatch.
//
// WHY THIS FILE EXISTS (regression intent): the 2026-07-16 UX audit's single
// P0 (design/ux-functional-audit-2026-07-16.md §2 F-0). An empty upstream
// list (audit agent with ZERO findings — the success case of Code→Audit→Fix)
// used to park an empty awaiting_review round with no doc_versions: invisible
// in the inbox, detail 404, canvas nav null, and submitReviewDecision 409 —
// the task wedged in awaiting_review forever. Dispatch must instead publish
// the same empty `accepted` + `approval_meta` an empty-subset human approval
// emits, close the run, and return kind:'ok' so the scheduler continues.
// If any of these go red, the P0 wedge is back.

import {
  agentFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  readNodeRunOutputFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
  readNodeRunFixtures,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'

import { describeEachProvider } from './helpers/eachProvider'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { dispatchReviewNode } from '@/modules/collaboration/infrastructure/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

describeEachProvider('RFC-202 T1 — empty-list review auto-approve', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-empty-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = harness.db
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  async function dispatchWithRootCheck(input: Parameters<typeof dispatchReviewNode>[0]) {
    const recording = harness.recordStatements()
    try {
      return await dispatchReviewNode({
        ...input,
        taskExecutionParticipants,
      })
    } finally {
      recording.stop()
      if (harness.capabilities.isolation !== 'exclusive') {
        let rootHeld = false
        let writes = 0
        for (const { sql: raw } of recording.statements) {
          const sql = raw.replaceAll('"agent_workflow".', '').toLowerCase()
          if (/^(begin|commit|rollback)(?:\s|$)/.test(sql)) rootHeld = false
          if (sql.includes('from "tasks"') && sql.includes('for update')) rootHeld = true
          if (
            /^(insert into|update|delete from) "(node_runs|node_run_inputs|node_run_outputs|doc_versions)"/.test(
              sql,
            )
          ) {
            expect(rootHeld).toBe(true)
            writes += 1
          }
        }
        expect(writes).toBeGreaterThan(0)
      }
    }
  }

  async function seed(portKind: 'list<path<md>>' | 'list<markdown>'): Promise<{
    taskId: string
    task: TaskReadRow
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    const caseGenId = ulid()
    await agentFixture(db, {
      id: caseGenId,
      name: 'caseGen',
      description: '',
      outputs: JSON.stringify(['cases']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: JSON.stringify({ outputKinds: { cases: portKind } }),
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'src',
          kind: 'agent-single',
          agentId: caseGenId,
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
    await workflowFixture(db, {
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await taskFixture(db, {
      id: taskId,
      name: 'empty-review',
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
    const task = (await readTaskFixtures(db, { id: taskId }))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  /** Upstream done run whose `cases` port is an EMPTY list. */
  async function seedEmptySrc(taskId: string, srcId: string): Promise<void> {
    await nodeRunFixture(db, {
      id: srcId,
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await nodeRunOutputFixture(db, { nodeRunId: srcId, portName: 'cases', content: '' })
  }

  async function reviewRun(taskId: string): Promise<PersistenceTables['nodeRuns']['$inferSelect']> {
    const { nodeRuns } = tablesOf(db)
    const rows = await db
      .select(nodeRunFixtureColumns(db))
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    const rev = rows.find((r) => r.nodeId === 'rev_1')
    expect(rev).toBeDefined()
    return rev!
  }

  async function outputsOf(
    runId: string,
  ): Promise<Map<string, { content: string; kind: string | null }>> {
    const rows = await readNodeRunOutputFixtures(db, { nodeRunId: runId })
    return new Map(rows.map((r) => [r.portName, { content: r.content, kind: r.kind ?? null }]))
  }

  test('path-kind empty list → run done, empty accepted list<path<md>>, meta auto-marked, audit event, zero doc_versions', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<path<md>>')
    await seedEmptySrc(taskId, '01SRC')
    const result = await dispatchWithRootCheck(
      withO2Closure({
        db,
        taskId,
        scopeRoot: task.worktreePath,
        appHome,
        definition,
        node: reviewNode,
        iteration: 0,
      }),
    )
    expect(result.kind).toBe('ok')
    expect(result.message).toBe('review-auto-approved')

    const rev = await reviewRun(taskId)
    expect(rev.status).toBe('done')

    const outs = await outputsOf(rev.id)
    expect(outs.get('accepted')).toEqual({ content: '', kind: 'list<path<md>>' })
    const metaRaw = outs.get('approval_meta')
    expect(metaRaw).toBeDefined()
    const meta = JSON.parse(metaRaw!.content) as Record<string, unknown>
    expect(meta['decision']).toBe('approved')
    expect(meta['auto']).toBe('empty-list')
    expect(meta['itemCount']).toBe(0)
    expect(meta['acceptedItemIndices']).toEqual([])
    // RFC-099 prompt isolation — no decider identity may enter a port.
    expect(Object.keys(meta)).not.toContain('decidedBy')
    expect(Object.keys(meta)).not.toContain('decidedByRole')

    const { nodeRunEvents } = tablesOf(db)
    const { docVersions } = tablesOf(db)
    // durable audit trace for the node drawer events tab
    const events = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, rev.id))
    expect(events.some((e) => e.payload.startsWith('[rfc202/review-auto-approved]'))).toBe(true)

    const dvs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    expect(dvs.length).toBe(0)
  })

  test('inline-kind (list<markdown>) empty list → empty accepted list<markdown>', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<markdown>')
    await seedEmptySrc(taskId, '01SRC')
    const result = await dispatchWithRootCheck(
      withO2Closure({
        db,
        taskId,
        scopeRoot: task.worktreePath,
        appHome,
        definition,
        node: reviewNode,
        iteration: 0,
      }),
    )
    expect(result.kind).toBe('ok')
    const rev = await reviewRun(taskId)
    expect(rev.status).toBe('done')
    const outs = await outputsOf(rev.id)
    expect(outs.get('accepted')).toEqual({ content: '', kind: 'list<markdown>' })
  })

  test('a stale visible review refreshed to an empty list retires the old round and releases the task atomically', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<path<md>>')
    const { docVersions } = tablesOf(db)
    await nodeRunFixture(db, {
      id: '01A_OLD',
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await nodeRunOutputFixture(db, {
      nodeRunId: '01A_OLD',
      portName: 'cases',
      content: 'old.md',
    })
    await seedEmptySrc(taskId, '01B_NEW')
    await patchTaskFixture(db, { id: taskId }, { status: 'awaiting_review' })
    const reviewRunId = ulid()
    await nodeRunFixture(db, {
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      consumedEdges: [{ producerNodeId: 'src', producerRunId: '01A_OLD' }],
      startedAt: Date.now(),
    })
    const oldVersionId = ulid()
    await insertOne(db, docVersions, {
      id: oldVersionId,
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'src',
      sourcePortName: 'cases',
      versionIndex: 1,
      reviewIteration: 0,
      ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', 'legacy/old.md')),
      itemIndex: 0,
      selection: 'unselected',
      roundGeneration: 1,
      decision: 'pending',
      createdAt: Date.now(),
    })

    const result = await dispatchWithRootCheck(
      withO2Closure({
        db,
        taskId,
        scopeRoot: task.worktreePath,
        appHome,
        definition,
        node: reviewNode,
        iteration: 0,
      }),
    )
    expect(result.kind).toBe('ok')
    expect((await readNodeRunFixtures(db, { id: reviewRunId }))[0]).toMatchObject({
      status: 'done',
      consumedEdges: [{ producerNodeId: 'src', producerRunId: '01B_NEW', producerShardKey: null }],
    })
    expect(
      (await db.select().from(docVersions).where(eq(docVersions.id, oldVersionId)))[0],
    ).toMatchObject({ decision: 'superseded', decisionReason: 'upstream-refreshed' })
    expect(await db.select().from(docVersions).where(eq(docVersions.decision, 'pending'))).toEqual(
      [],
    )
    expect((await readTaskFixtures(db, { id: taskId }))[0]!.status).toBe('pending')
  })

  test('wedged legacy row heals: existing awaiting_review round with zero doc_versions auto-approves on re-dispatch', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<path<md>>')
    await seedEmptySrc(taskId, '01SRC')
    // Simulate a pre-RFC-202 wedged row: parked awaiting_review, no doc_versions.
    const wedgedId = ulid()
    const { nodeRuns } = tablesOf(db)
    await nodeRunFixture(db, {
      id: wedgedId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    const result = await dispatchWithRootCheck(
      withO2Closure({
        db,
        taskId,
        scopeRoot: task.worktreePath,
        appHome,
        definition,
        node: reviewNode,
        iteration: 0,
      }),
    )
    expect(result.kind).toBe('ok')
    const after = (
      await db.select(nodeRunFixtureColumns(db)).from(nodeRuns).where(eq(nodeRuns.id, wedgedId))
    )[0]!
    expect(after.status).toBe('done')
    const outs = await outputsOf(wedgedId)
    expect(outs.get('accepted')?.content).toBe('')
    expect(outs.get('approval_meta')).toBeDefined()
  })
})
