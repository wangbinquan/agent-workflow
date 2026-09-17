// LOCKS: RFC-057 — S2 repair options (awaiting_human without open clarify_session).
// 2 options × 3 cases = 6 tests.

import { afterEach, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'
import { clarifyRounds } from '../src/db/schema'
import { eq } from 'drizzle-orm'

import {
  buildHarness,
  insertAlert,
  insertClarifySession,
  insertNodeRun,
  readAuditRows,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describeEachProvider('RFC-057 — S2.demote-task', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_human task → interrupted + resume', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S2.demote-task',
      actorUserId: 'u-1',
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer awaiting_human', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S2.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S2.unavailable.taskNotAwaitingHuman')
  })

  test('preview steps say the task gets resumed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S2.demote-task')
    // RFC-359 AC-1（第 8 刀）：预览断言的是**运维读到的意思**（这个修复会把任务重新拉起来），
    // 不再断言内部函数名 / 字面 SQL——合并后修复对话框统一给人话摘要，实现细节不出界面。
    expect(opt?.previewSteps.some((s) => s.includes('resume it'))).toBe(true)
  })
})

describeEachProvider('RFC-057 — S2.reopen-session', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: closed session for awaiting_human run → reopen', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'awaiting_human',
    })
    const sessId = await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S2.reopen-session',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    const sess = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, sessId)).limit(1)
    )[0]!
    expect(sess.status).toBe('awaiting_human')
  })

  test('preflight-stale: no awaiting_human run on the task', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    // No node_runs at all.
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S2.reopen-session')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.S2.reopenSession.unavailable.noAwaitingRun',
    )
  })

  test('preflight-stale: session already open (invariant should not have fired)', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'awaiting_human',
    })
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'awaiting_human',
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S2.reopen-session')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.S2.reopenSession.unavailable.sessionAlreadyOpen',
    )
  })
})
