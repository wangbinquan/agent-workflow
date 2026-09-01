// LOCKS: RFC-057 — T1 repair options (task awaiting_review but no run awaiting_review).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertNodeRun,
  readAlert,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — T1.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: task awaiting_review with no awaiting_review run → demote + resume', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1', taskId: h.taskId },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T1.demote-task',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
    const alert = await readAlert(h.db, alertId)
    expect(alert?.resolvedAt).not.toBeNull()
  })

  test('preflight-stale: task no longer awaiting_review', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1', taskId: h.taskId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T1.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.T1.unavailable.taskNotAwaitingReview')
  })

  test('preview steps include the SQL the engine will run', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T1.demote-task')
    expect(opt?.previewSteps.length).toBeGreaterThan(0)
    expect(opt?.previewSteps.some((s) => s.includes("status='interrupted'"))).toBe(true)
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})

describe('RFC-057 — T1.resurrect-review-run', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: terminal-non-done review run at current iter → flip to awaiting_review (allowTerminal)', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'interrupted',
      reviewIteration: 2,
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1' },
    })
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T1.resurrect-review-run',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('awaiting_review')
    // No resume kicked: this option leaves the task awaiting_review.
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({
      nodeRun: { id: reviewRunId, status: 'awaiting_review' },
    })
  })

  test('preflight-stale: no terminal-non-done review run → unavailable', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    // Only `done` runs: no candidate.
    await insertNodeRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'done', finishedAt: Date.now() })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T1.resurrect-review-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T1.resurrectReviewRun.unavailable.noCandidate',
    )
  })

  test('RFC-096: stale high-retryIndex terminal row does not shadow a later low-retry rerun (pure id-order pick)', async () => {
    // Red before RFC-096: findLatestTerminalReviewRun reduced the same-
    // reviewIteration group by HIGHEST retryIndex, so a retry storm on a stale
    // row (retryIndex=9, minted FIRST) shadowed a later clarify-rerun-style
    // row (retryIndex=1, larger id) — the exact bug class resumeTask fixed
    // once already; the in-memory reduce bypassed the SQL-text guards. The
    // candidate must now be the id-freshest row of the group.
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const staleHighRetry = await insertNodeRun(h.db, h.taskId, {
      id: 'nr_rfc096_t1_0001_stale',
      nodeId: 'rev_1',
      status: 'interrupted',
      retryIndex: 9,
      reviewIteration: 1,
      startedAt: 9_999_999_999_999, // realism: startedAt order must be inert too
      finishedAt: Date.now(),
    })
    const freshLowRetry = await insertNodeRun(h.db, h.taskId, {
      id: 'nr_rfc096_t1_0002_fresh', // minted later → larger id
      nodeId: 'rev_1',
      status: 'failed',
      retryIndex: 1,
      reviewIteration: 1,
      startedAt: 1_000,
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1' },
    })
    // Preflight preview names the id-freshest run, not the retry-storm row.
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T1.resurrect-review-run')
    expect(opt?.available).toBe(true)
    expect(opt?.previewSteps.some((s) => s.includes(freshLowRetry))).toBe(true)
    expect(opt?.previewSteps.some((s) => s.includes(staleHighRetry))).toBe(false)
    // Apply resurrects the fresh row; the stale storm row is left untouched.
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId,
      optionId: 'T1.resurrect-review-run',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, freshLowRetry)).toBe('awaiting_review')
    expect(await readNodeRunStatus(h.db, staleHighRetry)).toBe('interrupted')
  })

  test('skip when a sibling at same reviewIteration already done', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    // retry=0 done + retry=1 interrupted at same reviewIteration: the rule says
    // "done sibling exists" → no resurrection (the done one decides the iter).
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      retryIndex: 0,
      reviewIteration: 0,
    })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'interrupted',
      retryIndex: 1,
      reviewIteration: 0,
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T1',
      detail: { rule: 'T1' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T1.resurrect-review-run')
    expect(opt?.available).toBe(false)
  })
})
