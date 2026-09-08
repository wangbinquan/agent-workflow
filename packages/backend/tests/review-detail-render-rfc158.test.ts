// RFC-158 — getReviewDetail robustness the canvas nav oracle depends on:
//   R2b: the summary is built DIRECTLY by nodeRunId, not by scanning
//        listReviewSummaries(limit: 500) — so a review whose doc_versions aged
//        out of the global newest-500 window still renders (was a silent 404).
//   R6:  a single-doc review whose body FILE is missing renders with body=''
//        (the multi-doc path already tolerated it) — so "has doc_version ⟹
//        getReviewDetail renders" holds, which is what reviewNavKind !== null
//        promises the canvas.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { getReviewDetail } from '../src/services/review'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

async function seedTaskAndWorkflow(db: ProviderNeutralDatabase): Promise<{ taskId: string }> {
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: '{}',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId }
}

async function seedReviewRun(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: 100,
      finishedAt: null,
    })
    .run()
  return id
}

async function seedDocVersion(
  db: ProviderNeutralDatabase,
  taskId: string,
  reviewNodeRunId: string,
  opts: { versionIndex: number; createdAt: number; decision?: 'pending' | 'approved' },
): Promise<{ bodyPath: string }> {
  const bodyPath = `reviews/rev/docpath/${reviewNodeRunId}-v${opts.versionIndex}.md`
  await db
    .insert(docVersions)
    .values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId,
      sourceNodeId: 'agent',
      sourcePortName: 'docpath',
      versionIndex: opts.versionIndex,
      reviewIteration: 0,
      bodyPath,
      decision: opts.decision ?? 'pending',
      createdAt: opts.createdAt,
      decidedAt: null,
    })
    .run()
  return { bodyPath }
}

function writeBody(appHome: string, bodyPath: string, text: string): void {
  const abs = join(appHome, bodyPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

describeEachProvider(
  'RFC-158 — getReviewDetail renders whenever a doc_version exists',
  (harness) => {
    let db: ProviderNeutralDatabase
    let appHome: string
    beforeEach(() => {
      resetBroadcastersForTests()
      db = harness.db
      appHome = mkdtempSync(join(tmpdir(), 'aw-rfc158-detail-'))
    })
    afterEach(() => {
      resetBroadcastersForTests()
      rmSync(appHome, { recursive: true, force: true })
    })

    test('R2b: a review whose versions fall outside the global newest-500 window still renders', async () => {
      const { taskId } = await seedTaskAndWorkflow(db)
      // The target review — its single OLD doc_version (createdAt far in the past).
      const targetRun = await seedReviewRun(db, taskId)
      const { bodyPath } = await seedDocVersion(db, taskId, targetRun, {
        versionIndex: 1,
        createdAt: 1_000,
        decision: 'pending',
      })
      writeBody(appHome, bodyPath, '# target body')

      // 600 NEWER doc_versions on other runs — pushing the target out of the
      // global `ORDER BY created_at DESC LIMIT 500` window listReviewSummaries used.
      for (let i = 0; i < 600; i++) {
        const otherRun = await seedReviewRun(db, taskId)
        await seedDocVersion(db, taskId, otherRun, {
          versionIndex: 1,
          createdAt: 2_000_000 + i, // all newer than the target's 1_000
        })
      }

      const detail = await getReviewDetail(db, appHome, targetRun)
      expect(detail.summary.nodeRunId).toBe(targetRun)
      expect(detail.currentVersion.versionIndex).toBe(1)
      expect(detail.currentBody).toBe('# target body')
    })

    test('R6: single-doc review with a MISSING body file renders body="" (no doc-version-body-missing throw)', async () => {
      const { taskId } = await seedTaskAndWorkflow(db)
      const run = await seedReviewRun(db, taskId)
      // Row exists but we deliberately DO NOT write the body file to appHome.
      await seedDocVersion(db, taskId, run, {
        versionIndex: 1,
        createdAt: 5_000,
        decision: 'pending',
      })

      const detail = await getReviewDetail(db, appHome, run)
      expect(detail.summary.nodeRunId).toBe(run)
      expect(detail.currentBody).toBe('')
    })
  },
)
