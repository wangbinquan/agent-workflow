// LOCKS: RFC-057 — CR-1 repair options.
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  readAlert,
  readAuditRows,
  readTaskStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — CR-1.acknowledge', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('always available; apply leaves task + sessions untouched and only stamps audit + resolved', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'CR-1',
      detail: {
        rule: 'CR-1',
        crossClarifySessionId: 'cc-1',
        crossClarifyNodeId: 'ccn-1',
        targetDesignerNodeId: 'designer-1',
        iteration: 0,
      },
    })
    const taskStatusBefore = await readTaskStatus(h.db, h.taskId)
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'CR-1.acknowledge',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readTaskStatus(h.db, h.taskId)).toBe(taskStatusBefore)
    const alert = await readAlert(h.db, alertId)
    expect(alert?.resolvedAt).not.toBeNull()
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.optionId).toBe('CR-1.acknowledge')
    expect(audits[0]!.afterSnapshot).toMatchObject({ alert: { action: 'acknowledged' } })
  })

  test('preview steps explicitly mention "no data mutations"', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.acknowledge')
    expect(opt?.available).toBe(true)
    expect(opt?.previewSteps.some((s) => s.includes('No data mutations'))).toBe(true)
  })

  test('option is low-risk, non-destructive', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.acknowledge')
    expect(opt?.risk).toBe('low')
    expect(opt?.destructive).toBe(false)
  })
})

describe('RFC-057 — CR-1.retry-designer-rerun', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: failed task → interrupted + resume', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'CR-1.retry-designer-rerun',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task not failed', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.retry-designer-rerun')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.CR1.unavailable.taskNotFailed')
  })

  test('preview steps mention resumeTask', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.retry-designer-rerun')
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})
