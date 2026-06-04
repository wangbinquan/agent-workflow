// RFC-081 PR-C — multi-document review over an INLINE list<markdown> upstream.
//
// Mirrors review-multidoc.test.ts (list<path<md>>) but the upstream `cases`
// port carries the document BODIES inline (framed by MARKDOWN_DOC_BOUNDARY)
// instead of worktree paths. Locks:
//   - dispatch archives one doc_version per inline doc with item_path NULL and
//     the body taken directly from the wire content (no worktree file read).
//   - approve emits the accepted subset as list<markdown> (accepted bodies
//     joined by the boundary), NOT list<path<md>>.
//   - getReviewDetail still exposes documents[] (titles from the body heading).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
import {
  dispatchReviewNode,
  getReviewDetail,
  setDocumentSelection,
  submitReviewDecision,
} from '../src/services/review'
import { joinMarkdownDocs } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DOCS = ['# Alpha\n\nalpha body\nsecond line', '# Beta\n\nbeta body', '# Gamma\n\ngamma body']

describe('RFC-081 — multi-document review over inline list<markdown>', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-inline-'))
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

  async function seedAndDispatch(): Promise<{
    taskId: string
    reviewNodeRunId: string
    docs: (typeof docVersions.$inferSelect)[]
  }> {
    await db.insert(agentsTable).values({
      id: ulid(),
      name: 'caseGen',
      description: '',
      outputs: JSON.stringify(['cases']),
      readonly: false,
      permission: '{}',
      skills: '[]',
      // RFC-081: list<markdown> upstream → inline multi-document review.
      frontmatterExtra: JSON.stringify({ outputKinds: { cases: 'list<markdown>' } }),
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
      name: 'inline-multidoc',
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

    // Upstream done run: `cases` port carries the doc bodies inline.
    await db.insert(nodeRuns).values({
      id: '01SRC',
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: '01SRC', portName: 'cases', content: joinMarkdownDocs(DOCS) })

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
    const docs = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.taskId, taskId))
      .orderBy(docVersions.itemIndex)
    return { taskId, reviewNodeRunId: docs[0]!.reviewNodeRunId, docs }
  }

  test('dispatch archives one inline doc_version per document with item_path NULL', async () => {
    const { docs } = await seedAndDispatch()
    expect(docs.length).toBe(3)
    docs.forEach((d, i) => {
      expect(d.itemIndex).toBe(i)
      expect(d.itemPath).toBeNull()
      expect(d.sourceFilePath).toBeNull()
      expect(d.selection).toBe('unselected')
      expect(d.decision).toBe('pending')
    })
    expect(new Set(docs.map((d) => d.reviewNodeRunId)).size).toBe(1)
  })

  test('getReviewDetail exposes inline documents with titles from the body heading', async () => {
    const { reviewNodeRunId } = await seedAndDispatch()
    const detail = await getReviewDetail(db, appHome, reviewNodeRunId)
    expect(detail.documents).toBeDefined()
    expect(detail.documents!.map((d) => d.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(detail.documents!.every((d) => d.itemPath === '')).toBe(true)
    // currentBody is the first inline document's body verbatim.
    expect(detail.currentBody).toBe(DOCS[0]!)
  })

  test('approve emits the accepted subset as list<markdown> (bodies, boundary-joined)', async () => {
    const { reviewNodeRunId, docs } = await seedAndDispatch()
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[0]!.id,
      selection: 'accepted',
    })
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[1]!.id,
      selection: 'not_accepted',
    })
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[2]!.id,
      selection: 'accepted',
    })

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    })

    const accepted = (
      await db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, reviewNodeRunId),
            eq(nodeRunOutputs.portName, 'accepted'),
          ),
        )
    )[0]!
    // accepted = Alpha (0) + Gamma (2), in item order, joined by the boundary.
    expect(accepted.kind).toBe('list<markdown>')
    expect(accepted.content).toBe(joinMarkdownDocs([DOCS[0]!, DOCS[2]!]))

    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewNodeRunId)))[0]!
    expect(run.status).toBe('done')
  })
})
