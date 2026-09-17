// LOCKS: RFC-057 — S4 repair options (task pending too long).
// 2 options × 3 cases = 6 tests.

import { afterEach, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'

import {
  buildHarness,
  insertAlert,
  readAuditRows,
  readTaskStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describeEachProvider('RFC-057 — S4.kick-task', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: pending task → interrupted + resume', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S4',
      detail: { rule: 'S4', pendingForMs: 999_999 },
    })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S4.kick-task',
      actorUserId: 'u-1',
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer pending', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S4.kick-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S4.unavailable.taskNotPending')
  })

  test('preview steps say the task gets resumed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S4.kick-task')
    // RFC-359 AC-1（第 8 刀）：预览断言的是**运维读到的意思**（这个修复会把任务重新拉起来），
    // 不再断言内部函数名 / 字面 SQL——合并后修复对话框统一给人话摘要，实现细节不出界面。
    expect(opt?.previewSteps.some((s) => s.includes('resume it'))).toBe(true)
  })
})

describeEachProvider('RFC-057 — S4.cancel-task', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: pending task → canceled', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S4.cancel-task',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    expect(await readTaskStatus(h.db, h.taskId)).toBe('canceled')
  })

  test('preflight-stale: task no longer pending', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S4.cancel-task')
    expect(opt?.available).toBe(false)
  })

  test('destructive + high risk', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S4.cancel-task')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})
