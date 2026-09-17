// LOCKS: RFC-057 — C1 repair options (clarify_session closed but clarify run still awaiting_human).
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
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describeEachProvider('RFC-057 — C1.resume-run', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: closed session + awaiting_human run → run flips to done', async () => {
    h = await buildHarness(provider.db, {
      taskStatus: 'awaiting_human',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
        edges: [],
      },
    })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'awaiting_human',
    })
    const sessId = await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: {
        rule: 'C1',
        clarifySessionId: sessId,
        clarifyNodeRunId: clarifyRunId,
        clarifyNodeId: 'clarify_1',
        clarifySessionStatus: 'answered',
        actualStatus: 'awaiting_human',
      },
    })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'C1.resume-run',
      actorUserId: 'u-1',
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, clarifyRunId)).toBe('done')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({
      nodeRun: { id: clarifyRunId, status: 'done' },
    })
  })

  test('preflight-stale: run no longer awaiting_human', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'done',
    })
    const sessId = await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: { rule: 'C1', clarifySessionId: sessId, clarifyNodeRunId: clarifyRunId },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'C1.resume-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.C1.unavailable.runNotAwaitingHuman')
  })

  test('detail drift: clarifyNodeRunId missing → unavailable', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: { rule: 'C1' /* missing ids */ },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'C1.resume-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.C1.unavailable.detailDrift')
  })
})

describeEachProvider('RFC-057 — C1.reopen-session', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: session → awaiting_human + answers cleared; run untouched', async () => {
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
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: { rule: 'C1', clarifySessionId: sessId, clarifyNodeRunId: clarifyRunId },
    })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'C1.reopen-session',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, clarifyRunId)).toBe('awaiting_human')
    const sessAfter = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, sessId)).limit(1)
    )[0]!
    expect(sessAfter.status).toBe('awaiting_human')
    expect(sessAfter.answersJson).toBeNull()
    expect(sessAfter.answeredAt).toBeNull()
  })

  test('preflight-stale: run no longer awaiting_human', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'done',
    })
    const sessId = await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: { rule: 'C1', clarifySessionId: sessId, clarifyNodeRunId: clarifyRunId },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'C1.reopen-session')
    expect(opt?.available).toBe(false)
  })

  test('option metadata: low/medium risk', async () => {
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
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'C1',
      detail: { rule: 'C1', clarifySessionId: sessId, clarifyNodeRunId: clarifyRunId },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    expect(list.options.find((o) => o.id === 'C1.resume-run')?.risk).toBe('low')
    expect(list.options.find((o) => o.id === 'C1.reopen-session')?.risk).toBe('medium')
  })
})
