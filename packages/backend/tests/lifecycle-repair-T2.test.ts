// LOCKS: RFC-057 — T2 repair options (task awaiting_human but no awaiting_human run).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
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

describe('RFC-057 — T2.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_human task with no awaiting_human run → demote + resume', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T2',
      detail: { rule: 'T2', taskId: h.taskId },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T2.demote-task',
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
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.T2.unavailable.taskNotAwaitingHuman')
  })

  test('preview steps mention resumeTask + SQL', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.demote-task')
    expect(opt?.previewSteps.length).toBeGreaterThan(0)
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})

describe('RFC-057 — T2.resurrect-clarify-run', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: terminal clarify run + open clarify_session → flip back to awaiting_human', async () => {
    h = await buildHarness({
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
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'awaiting_human',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T2',
      detail: { rule: 'T2' },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T2.resurrect-clarify-run',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, clarifyRunId)).toBe('awaiting_human')
  })

  test('preflight-stale: no terminal clarify run', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_human',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
        edges: [],
      },
    })
    await insertNodeRun(h.db, h.taskId, { nodeId: 'clarify_1', status: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.resurrect-clarify-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T2.resurrectClarifyRun.unavailable.noCandidate',
    )
  })

  test('preflight-stale: terminal run exists but no open clarify_session', async () => {
    h = await buildHarness({
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
      status: 'interrupted',
    })
    // Closed session — preflight should refuse.
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.resurrect-clarify-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T2.resurrectClarifyRun.unavailable.noOpenSession',
    )
  })
})

// RFC-074 PR-C / T-C4b (design §6.4.1, §11.3) — the C-group lock for T2's
// id-ordered clarify-generation selection. `findClarifyResurrectionTarget` no
// longer groups by the retired clarifyIteration; per clarify node it takes the
// LATEST row by id and only resurrects when THAT row is terminal-non-done. A
// regression to "any stuck row" (the pre-RFC-074 cci-grouped shape) would
// resurrect a superseded older generation. These two cases pin the boundary.
describe('RFC-074 PR-C — T2.resurrect id-ordered generation selection', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  const clarifyWf = {
    $schema_version: 4 as const,
    inputs: [],
    nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
    edges: [],
  }

  test('newer generation reached done → no resurrection even with an older stuck row', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human', workflow: clarifyWf })
    // gen0 (older id) is a stuck interrupted round; gen1 (newer id) is a fresh
    // round that reached done — the clarify resolved, so T2 must NOT resurrect.
    await insertNodeRun(h.db, h.taskId, {
      id: '01TESTGEN0',
      nodeId: 'clarify_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    await insertNodeRun(h.db, h.taskId, {
      id: '01TESTGEN1',
      nodeId: 'clarify_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.resurrect-clarify-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T2.resurrectClarifyRun.unavailable.noCandidate',
    )
  })

  test('newer generation is stuck → resurrect the NEWER (max id), leaving the older done row', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human', workflow: clarifyWf })
    // gen0 (older id) resolved to done; gen1 (newer id) is the stuck round with
    // an open session — resurrection targets gen1, not the older done gen0.
    const gen0 = await insertNodeRun(h.db, h.taskId, {
      id: '01TESTGEN0',
      nodeId: 'clarify_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    const gen1 = await insertNodeRun(h.db, h.taskId, {
      id: '01TESTGEN1',
      nodeId: 'clarify_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: gen1,
      status: 'awaiting_human',
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T2.resurrect-clarify-run',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, gen1)).toBe('awaiting_human')
    expect(await readNodeRunStatus(h.db, gen0)).toBe('done') // older generation untouched
  })
})
