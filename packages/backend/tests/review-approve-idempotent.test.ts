import { nodeRunFixtureColumns } from './helpers/model/nodeRun'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { withO2Closure } from './helpers/o2Closure'
// RFC-052 regression: `submitReviewDecision({ decision: 'approved' })` must
// upsert (NOT plain-insert) the `approved_doc` + `approval_meta` rows into
// node_run_outputs. Without that, a second approve on the same node_run
// row — which is exactly what the pre-RFC-052 dispatch-reset bug provoked —
// hit the (node_run_id, port_name) PK and threw, which left the
// status='done' + finishedAt update unexecuted and the resumeRequired
// signal lost. Result: review row stayed `awaiting_review` forever even
// though the doc_version was approved.

import {
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunOutputFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { submitReviewDecision } from '@/modules/collaboration/infrastructure/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('submitReviewDecision approved branch is idempotent (RFC-052)', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc052-approve-'))
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

  test('approve does NOT crash when node_run_outputs already has approved_doc/approval_meta rows', async () => {
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
      ],
      edges: [],
    }
    const workflowId = ulid()
    const { nodeRuns, docVersions } = tablesOf(db)
    await workflowFixture(db, {
      id: workflowId,
      name: 'w',
      definition: JSON.stringify(definition),
    })

    const taskId = ulid()
    // RFC-359: the old SQLite fixture received these root fields from migration 0210's
    // task INSERT trigger. Keep its JSON key order: continuationSlotKey hashes the raw string.
    const lineageSlotPathJson = JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ])
    await taskFixture(db, {
      name: 'rfc-052-approve',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
      executionLineageId: taskId,
      lineageSlotPathJson,
    })
    // Both providers must start from the original SQLite-materialized row.
    expect(
      (
        await readTaskFixtures(db, { id: taskId }).then((rows) =>
          rows.map((row) => ({
            executionLineageId: row.executionLineageId,
            lineageSlotPathJson: row.lineageSlotPathJson,
          })),
        )
      )[0],
    ).toEqual({ executionLineageId: taskId, lineageSlotPathJson })

    // Review run currently awaiting a decision.
    const reviewRunId = ulid()
    await nodeRunFixture(db, {
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 4,
      startedAt: Date.now() - 200,
    })

    // Pending doc_version the user is about to approve.
    const bodyPathRel = 'doc_versions/v1.md'
    mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
    writeFileSync(join(appHome, bodyPathRel), '# approved body\n')
    await insertOne(db, docVersions, {
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 5,
      reviewIteration: 4,
      ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', bodyPathRel)),
      decision: 'pending',
    })

    // The smoking gun: a prior crashed-approve already wrote both output
    // rows. Without RFC-052's upsert, the next approve would throw PK on
    // these.
    await nodeRunOutputFixture(db, {
      nodeRunId: reviewRunId,
      portName: 'approved_doc',
      content: '[stale leftover from a prior crashed approve]',
    })
    await nodeRunOutputFixture(db, {
      nodeRunId: reviewRunId,
      portName: 'approval_meta',
      content: '{"stale":true}',
    })

    const result = await submitReviewDecision(
      withO2Closure({
        db,
        appHome,
        nodeRunId: reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 4,
        author: 'tester',
      }),
    )

    expect(result.resumeRequired).toBe(true)
    expect(result.taskId).toBe(taskId)

    // node_run is now done with a finishedAt timestamp.
    const after = (
      await db.select(nodeRunFixtureColumns(db)).from(nodeRuns).where(eq(nodeRuns.id, reviewRunId))
    )[0]!
    expect(after.status).toBe('done')
    expect(typeof after.finishedAt).toBe('number')

    // Outputs got overwritten by the upsert.
    const outs = await readNodeRunOutputFixtures(db, { nodeRunId: reviewRunId })
    expect(outs.length).toBe(2)
    const approvedDoc = outs.find((o) => o.portName === 'approved_doc')!
    expect(approvedDoc.content).not.toContain('stale leftover')
    const approvalMeta = outs.find((o) => o.portName === 'approval_meta')!
    expect(approvalMeta.content).not.toContain('"stale":true')
    // The new approval_meta JSON contains the rfc-052-compatible shape.
    const parsedMeta = JSON.parse(approvalMeta.content) as Record<string, unknown>
    expect(parsedMeta.decision).toBe('approved')
    expect(parsedMeta.reviewIteration).toBe(4)
    expect(parsedMeta.versionIndex).toBe(5)
  })
})
