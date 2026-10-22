// RFC-072 follow-up — migration 0038 backfills node_run_outputs.kind for
// review-approved file docs that predate kind-persistence. The marker is
// reliable (not heuristic): doc_versions.source_file_path is non-NULL exactly
// when the reviewed upstream port was kind markdown_file, so approved_doc holds
// a worktree-relative path. createInMemoryDb already applied 0038 on empty data,
// so we re-run the idempotent (kind IS NULL-gated) UPDATE against freshly seeded
// rows to exercise the backfill logic.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKFILL_SQL = readFileSync(
  resolve(MIGRATIONS, '0038_rfc072_backfill_review_output_kind.sql'),
  'utf8',
)

async function seedReviewApproval(
  db: DbClient,
  opts: { taskId: string; reviewRunId: string; sourceFilePath: string | null; content: string },
): Promise<void> {
  const { nodeRuns, nodeRunOutputs, docVersions } = tablesOf(db)
  await insertOne(db, nodeRuns, {
    id: opts.reviewRunId,
    taskId: opts.taskId,
    nodeId: 'rev_1',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: Date.now(),
  })
  await insertOne(db, nodeRunOutputs, {
    nodeRunId: opts.reviewRunId,
    portName: 'approved_doc',
    content: opts.content,
    // kind intentionally omitted → NULL, simulating a pre-RFC-072 row.
  })
  await insertOne(db, docVersions, {
    id: `${opts.reviewRunId}-dv`,
    taskId: opts.taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: opts.reviewRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'doc_versions/v1.md',
    sourceFilePath: opts.sourceFilePath,
    decision: 'approved',
  })
}

describe('RFC-072 — migration 0038 backfills review approved_doc kind', () => {
  test('file-backed approval → markdown_file; inline approval → stays NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { workflows, tasks, nodeRunOutputs } = tablesOf(db)
    await insertOne(db, workflows, {
      id: 'wf',
      name: 'wf',
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 4,
    })
    await insertOne(db, tasks, {
      id: 't1',
      name: 't1',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/r',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
    })
    // File-backed review approval (upstream markdown_file → source_file_path set).
    await seedReviewApproval(db, {
      taskId: 't1',
      reviewRunId: 'rev_file',
      sourceFilePath: 'docs/design.md',
      content: 'docs/design.md',
    })
    // Inline-markdown approval (no source_file_path → not a file).
    await seedReviewApproval(db, {
      taskId: 't1',
      reviewRunId: 'rev_inline',
      sourceFilePath: null,
      content: '# inline body',
    })

    // Pre-condition: both NULL.
    const before = await db.select().from(nodeRunOutputs)
    expect(before.every((r) => r.kind === null)).toBe(true)

    // Re-run the actual migration SQL.
    await rawExec(db, sql.raw(BACKFILL_SQL))

    const fileRow = (
      await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, 'rev_file'))
    )[0]
    const inlineRow = (
      await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, 'rev_inline'))
    )[0]
    expect(fileRow?.kind).toBe('markdown_file')
    expect(inlineRow?.kind).toBeNull()
  })
})
