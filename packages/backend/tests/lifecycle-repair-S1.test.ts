// LOCKS: RFC-057 — S1 repair options (awaiting_review without pending doc_version).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { docVersions, nodeRunOutputs } from '../src/db/schema'
import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import { withTaskReviewMutationLock } from '../src/services/reviewMutationCoordinator'
import { cancelTask } from '../src/services/task'
import {
  buildHarness,
  insertAlert,
  insertNodeRun,
  readAuditRows,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — S1.recreate-doc-version', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_review run + done source with output → mints fresh pending doc_version', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          { id: 'src', kind: 'agent-single', agentName: 'doc' } as never,
          {
            id: 'rev_1',
            kind: 'review',
            inputSource: { nodeId: 'src', portName: 'docpath' },
          } as never,
        ],
        edges: [],
      },
    })
    // done source run with a port output (inline markdown).
    const srcRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'src',
      status: 'done',
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: srcRunId,
      portName: 'docpath',
      content: '# Demo doc body\n\nInline markdown sourced from src.',
    })
    // awaiting_review review run, no doc_version (S1 violation shape).
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: {
        rule: 'S1',
        repairHint: { kind: 'review', nodeRunId: reviewRunId },
      },
    })

    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    // A pending doc_version should now exist for the review run.
    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, reviewRunId))
    expect(dvs.some((d) => d.decision === 'pending')).toBe(true)
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.optionId).toBe('S1.recreate-doc-version')
  })

  test('preflight-stale: task no longer awaiting_review', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S1.recreate-doc-version')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S1.unavailable.taskNotAwaitingReview')
  })

  test('cancel first makes queued recreate-doc repair a zero-write stale loser', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          { id: 'src', kind: 'agent-single', agentName: 'doc' } as never,
          {
            id: 'rev_1',
            kind: 'review',
            inputSource: { nodeId: 'src', portName: 'docpath' },
          } as never,
        ],
        edges: [],
      },
    })
    const srcRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'src',
      status: 'done',
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: srcRunId,
      portName: 'docpath',
      content: '# must not be recreated',
    })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: { rule: 'S1', repairHint: { kind: 'review', nodeRunId: reviewRunId } },
    })
    let releaseHolder: () => void = () => {}
    let holderEntered: () => void = () => {}
    const blocked = new Promise<void>((resolveBlocked) => {
      releaseHolder = resolveBlocked
    })
    const entered = new Promise<void>((resolveEntered) => {
      holderEntered = resolveEntered
    })
    const holder = withTaskReviewMutationLock(h.taskId, async () => {
      holderEntered()
      await blocked
    })
    await entered

    const cancel = cancelTask(h.db, h.taskId)
    const repair = applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    releaseHolder()
    await holder
    await cancel
    await expect(repair).rejects.toMatchObject({ code: 'repair-preflight-stale' })
    expect(
      await h.db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, reviewRunId)),
    ).toHaveLength(0)
  })

  test('preflight-stale: workflow has no review nodes', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'out_1', kind: 'output', ports: [] } as never],
        edges: [],
      },
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S1.recreate-doc-version')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S1.unavailable.noReviewNode')
  })
})

describe('RFC-057 — S1.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_review task → interrupted + resume', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'S1.demote-task',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task not awaiting_review', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S1.demote-task')
    expect(opt?.available).toBe(false)
  })

  test('option metadata distribution: low + medium', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(list.options.find((o) => o.id === 'S1.recreate-doc-version')?.risk).toBe('low')
    expect(list.options.find((o) => o.id === 'S1.demote-task')?.risk).toBe('medium')
  })
})
