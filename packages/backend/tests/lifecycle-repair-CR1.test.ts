// LOCKS: RFC-057 — CR-1 repair options.
// 2 options × 3 cases = 6 tests.

import { afterEach, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'

import {
  buildHarness,
  insertAlert,
  readAlert,
  readAuditRows,
  readTaskStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describeEachProvider('RFC-057 — CR-1.acknowledge', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('always available; apply leaves task + sessions untouched and only stamps audit + resolved', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
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
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'CR-1.acknowledge',
      actorUserId: 'u-1',
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
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.acknowledge')
    expect(opt?.available).toBe(true)
    expect(opt?.previewSteps.some((s) => s.includes('No data mutations'))).toBe(true)
  })

  test('option is low-risk, non-destructive', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.acknowledge')
    expect(opt?.risk).toBe('low')
    expect(opt?.destructive).toBe(false)
  })
})

describeEachProvider('RFC-057 — CR-1.retry-designer-rerun', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: failed task → interrupted + resume', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'CR-1.retry-designer-rerun',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task not failed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.retry-designer-rerun')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.CR1.unavailable.taskNotFailed')
  })

  test('preview steps say the task gets resumed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'CR-1', detail: { rule: 'CR-1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'CR-1.retry-designer-rerun')
    // RFC-359 AC-1（第 8 刀）：预览断言的是**运维读到的意思**（这个修复会把任务重新拉起来），
    // 不再断言内部函数名 / 字面 SQL——合并后修复对话框统一给人话摘要，实现细节不出界面。
    expect(opt?.previewSteps.some((s) => s.includes('resume it'))).toBe(true)
  })
})
