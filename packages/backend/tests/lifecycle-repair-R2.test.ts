// LOCKS: RFC-057 — R2 repair options (review run done but no approved doc_version).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertNodeRun,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — R2.demote-run-to-awaiting', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: done review run with no approved doc → flips back to awaiting_review', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2', reviewNodeRunId: reviewRunId, reviewNodeId: 'rev_1' },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'R2.demote-run-to-awaiting',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('awaiting_review')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({
      nodeRun: { id: reviewRunId, status: 'awaiting_review' },
    })
  })

  test('preflight-stale: run no longer done', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2', reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R2.demote-run-to-awaiting')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R2.unavailable.runNotDone')
  })

  test('detail drift: reviewNodeRunId missing → unavailable', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2' /* reviewNodeRunId omitted */ },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R2.demote-run-to-awaiting')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R2.unavailable.detailDrift')
  })
})

describe('RFC-057 — R2.mark-task-failed', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: non-terminal task → failed', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2', reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'R2.mark-task-failed',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'failed' } })
  })

  test('preflight-stale: task already terminal', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2', reviewNodeRunId: 'r' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R2.mark-task-failed')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R2.unavailable.taskTerminal')
  })

  test('destructive + high risk', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R2',
      detail: { rule: 'R2', reviewNodeRunId: 'r' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R2.mark-task-failed')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})
