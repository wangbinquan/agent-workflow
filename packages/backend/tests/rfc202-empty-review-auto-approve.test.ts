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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  docVersions,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-202 T1 — empty-list review auto-approve', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-empty-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  async function seed(portKind: 'list<path<md>>' | 'list<markdown>'): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    const caseGenId = ulid()
    await db.insert(agentsTable).values({
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
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  /** Upstream done run whose `cases` port is an EMPTY list. */
  async function seedEmptySrc(taskId: string, srcId: string): Promise<void> {
    await db.insert(nodeRuns).values({
      id: srcId,
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({ nodeRunId: srcId, portName: 'cases', content: '' })
  }

  async function reviewRun(taskId: string): Promise<typeof nodeRuns.$inferSelect> {
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const rev = rows.find((r) => r.nodeId === 'rev_1')
    expect(rev).toBeDefined()
    return rev!
  }

  async function outputsOf(
    runId: string,
  ): Promise<Map<string, { content: string; kind: string | null }>> {
    const rows = await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, runId))
    return new Map(rows.map((r) => [r.portName, { content: r.content, kind: r.kind ?? null }]))
  }

  test('path-kind empty list → run done, empty accepted list<path<md>>, meta auto-marked, audit event, zero doc_versions', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<path<md>>')
    await seedEmptySrc(taskId, '01SRC')
    const result = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
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

    // durable audit trace for the node drawer events tab
    const events = await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, rev.id))
    expect(events.some((e) => e.payload.startsWith('[rfc202/review-auto-approved]'))).toBe(true)

    const dvs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    expect(dvs.length).toBe(0)
  })

  test('inline-kind (list<markdown>) empty list → empty accepted list<markdown>', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<markdown>')
    await seedEmptySrc(taskId, '01SRC')
    const result = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('ok')
    const rev = await reviewRun(taskId)
    expect(rev.status).toBe('done')
    const outs = await outputsOf(rev.id)
    expect(outs.get('accepted')).toEqual({ content: '', kind: 'list<markdown>' })
  })

  test('wedged legacy row heals: existing awaiting_review round with zero doc_versions auto-approves on re-dispatch', async () => {
    const { taskId, task, definition, reviewNode } = await seed('list<path<md>>')
    await seedEmptySrc(taskId, '01SRC')
    // Simulate a pre-RFC-202 wedged row: parked awaiting_review, no doc_versions.
    const wedgedId = ulid()
    await db.insert(nodeRuns).values({
      id: wedgedId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
    })
    const result = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('ok')
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, wedgedId)))[0]!
    expect(after.status).toBe('done')
    const outs = await outputsOf(wedgedId)
    expect(outs.get('accepted')?.content).toBe('')
    expect(outs.get('approval_meta')).toBeDefined()
  })
})
