// LOCKS: RFC-057 — S2 repair options (awaiting_human without open clarify_session).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'
import { clarifyRounds } from '../src/db/schema'
import { eq } from 'drizzle-orm'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertClarifySession,
  insertNodeRun,
  readAuditRows,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — S2.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_human task → interrupted + resume', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'S2.demote-task',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer awaiting_human', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S2.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S2.unavailable.taskNotAwaitingHuman')
  })

  test('preview steps mention resumeTask', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S2.demote-task')
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})

describe('RFC-057 — S2.reopen-session', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: closed session for awaiting_human run → reopen', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
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
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'S2.reopen-session',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const sess = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, sessId)).limit(1)
    )[0]!
    expect(sess.status).toBe('awaiting_human')
  })

  test('preflight-stale: no awaiting_human run on the task', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    // No node_runs at all.
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S2', detail: { rule: 'S2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S2.reopen-session')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.S2.reopenSession.unavailable.noAwaitingRun',
    )
  })

  test('preflight-stale: session already open (invariant should not have fired)', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
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
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'S2.reopen-session')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.S2.reopenSession.unavailable.sessionAlreadyOpen',
    )
  })
})
