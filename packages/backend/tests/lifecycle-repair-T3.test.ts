// LOCKS: RFC-057 — T3 repair options (task done but output node not done).
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

describeEachProvider('RFC-057 — T3.demote-task', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: done task with missing output → demote to interrupted + resume', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T3',
      detail: { rule: 'T3', missingOutputNodeIds: ['out_1'] },
    })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'T3.demote-task',
      actorUserId: 'u-1',
    })
    expect(res.outcome).toBe('success')
    // task was demoted to interrupted (pre-resume); resumeTask kicks runTask
    // in background — task may end up `pending` or `done` depending on race.
    // We assert via audit afterSnapshot for determinism.
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer done', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T3',
      detail: { rule: 'T3', missingOutputNodeIds: ['out_1'] },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'T3.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.T3.unavailable.taskNotDone')
  })

  test('option metadata: low/medium/high risk distribution', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    expect(list.options.find((o) => o.id === 'T3.demote-task')?.risk).toBe('medium')
    expect(list.options.find((o) => o.id === 'T3.mark-task-failed')?.risk).toBe('high')
    expect(list.options.find((o) => o.id === 'T3.mark-task-failed')?.destructive).toBe(true)
  })
})

describeEachProvider('RFC-057 — T3.mark-task-failed', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: done task → failed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'T3.mark-task-failed',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    expect(await readTaskStatus(h.db, h.taskId)).toBe('failed')
  })

  test('preflight-stale: task is interrupted (not done)', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'interrupted' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'T3.mark-task-failed')
    expect(opt?.available).toBe(false)
  })

  test('audit row contains before snapshot of done state', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'T3.mark-task-failed',
      actorUserId: null,
    })
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.beforeSnapshot).toMatchObject({ task: { status: 'done' } })
  })
})
