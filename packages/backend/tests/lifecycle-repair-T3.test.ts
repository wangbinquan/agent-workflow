// LOCKS: RFC-057 — T3 repair options (task done but output node not done).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  readAuditRows,
  readTaskStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — T3.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: done task with missing output → demote to interrupted + resume', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T3',
      detail: { rule: 'T3', missingOutputNodeIds: ['out_1'] },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T3.demote-task',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    // task was demoted to interrupted (pre-resume); resumeTask kicks runTask
    // in background — task may end up `pending` or `done` depending on race.
    // We assert via audit afterSnapshot for determinism.
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer done', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T3',
      detail: { rule: 'T3', missingOutputNodeIds: ['out_1'] },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T3.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.T3.unavailable.taskNotDone')
  })

  test('option metadata: low/medium/high risk distribution', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(list.options.find((o) => o.id === 'T3.demote-task')?.risk).toBe('medium')
    expect(list.options.find((o) => o.id === 'T3.mark-task-failed')?.risk).toBe('high')
    expect(list.options.find((o) => o.id === 'T3.mark-task-failed')?.destructive).toBe(true)
  })
})

describe('RFC-057 — T3.mark-task-failed', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: done task → failed', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T3.mark-task-failed',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readTaskStatus(h.db, h.taskId)).toBe('failed')
  })

  test('preflight-stale: task is interrupted (not done)', async () => {
    h = await buildHarness({ taskStatus: 'interrupted' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T3.mark-task-failed')
    expect(opt?.available).toBe(false)
  })

  test('audit row contains before snapshot of done state', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T3', detail: { rule: 'T3' } })
    await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T3.mark-task-failed',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.beforeSnapshot).toMatchObject({ task: { status: 'done' } })
  })
})
