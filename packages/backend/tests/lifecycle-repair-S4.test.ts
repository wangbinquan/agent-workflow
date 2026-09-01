// LOCKS: RFC-057 — S4 repair options (task pending too long).
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

describe('RFC-057 — S4.kick-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: pending task → interrupted + resume', async () => {
    h = await buildHarness({ taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S4',
      detail: { rule: 'S4', pendingForMs: 999_999 },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'S4.kick-task',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer pending', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S4.kick-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S4.unavailable.taskNotPending')
  })

  test('preview steps mention resumeTask', async () => {
    h = await buildHarness({ taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S4.kick-task')
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})

describe('RFC-057 — S4.cancel-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: pending task → canceled', async () => {
    h = await buildHarness({ taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'S4.cancel-task',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readTaskStatus(h.db, h.taskId)).toBe('canceled')
  })

  test('preflight-stale: task no longer pending', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S4.cancel-task')
    expect(opt?.available).toBe(false)
  })

  test('destructive + high risk', async () => {
    h = await buildHarness({ taskStatus: 'pending' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S4', detail: { rule: 'S4' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S4.cancel-task')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})
