// LOCKS: RFC-057 — R1 repair options (approved doc_version but review run not done).
// 3 options × 3 cases = 9 tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { DbClient } from '../src/db/client'
import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '../src/db/schema'
import {
  applyRepairOption,
  listRepairOptionsForAlert,
  type PreflightResult,
  type RepairContext,
  type RepairOptionDef,
} from '../src/services/lifecycleRepair'
import { R1_OPTIONS } from '../src/services/lifecycleRepair/options-R1'
import { registerTerminalTaskHook } from '../src/services/lifecycle'
import { withTaskReviewMutationLock } from '../src/services/reviewMutationCoordinator'
import { cancelTask } from '../src/services/task'
import { sealOpenHumanGatesForTask } from '../src/services/terminalSweep'
import {
  buildHarness,
  insertAlert,
  insertDocVersion,
  insertNodeRun,
  readAlert,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

type R1WriterId = 'R1.approve-run' | 'R1.unapprove-doc'

interface R1WriterCase {
  h: RepairHarness
  reviewRunId: string
  dvId: string
  option: RepairOptionDef
  rc: RepairContext
  pre: PreflightResult
}

async function seedR1WriterCase(optionId: R1WriterId): Promise<R1WriterCase> {
  const h = await buildHarness({ taskStatus: 'awaiting_review' })
  const reviewRunId = await insertNodeRun(h.db, h.taskId, {
    nodeId: 'rev_1',
    status: 'awaiting_review',
  })
  const dvId = await insertDocVersion(h.db, h.taskId, {
    reviewNodeRunId: reviewRunId,
    reviewNodeId: 'rev_1',
    decision: 'approved',
    versionIndex: 3,
    reviewIteration: 2,
  })
  const detail = {
    rule: 'R1',
    docVersionId: dvId,
    reviewNodeRunId: reviewRunId,
    reviewNodeId: 'rev_1',
    actualStatus: 'awaiting_review',
  }
  const alertId = await insertAlert(h.db, h.taskId, { rule: 'R1', detail })
  const task = (
    await h.db
      .select({
        id: tasks.id,
        status: tasks.status,
        workflowSnapshot: tasks.workflowSnapshot,
        workgroupId: tasks.workgroupId,
        workgroupConfigJson: tasks.workgroupConfigJson,
      })
      .from(tasks)
      .where(eq(tasks.id, h.taskId))
      .limit(1)
  )[0]!
  const rc: RepairContext = {
    db: h.db,
    alert: {
      id: alertId,
      taskId: h.taskId,
      rule: 'R1',
      severity: 'warning',
      detail,
      detectedAt: Date.now(),
      resolvedAt: null,
    },
    task,
    actorUserId: 'r1-concurrency-test',
    appHome: h.tmpDir,
    deps: h.deps,
    now: Date.now,
  }
  const option = R1_OPTIONS.find((candidate) => candidate.id === optionId)
  if (option === undefined) throw new Error(`missing ${optionId}`)
  const pre = await option.preflight(rc)
  if (!pre.available) throw new Error(`${optionId} test preflight unexpectedly unavailable`)
  return { h, reviewRunId, dvId, option, rc, pre }
}

async function settleR1InOrder<A, B>(
  taskId: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let releaseHolder: () => void = () => {}
  let markEntered: () => void = () => {}
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    releaseHolder = resolve
  })
  const holder = withTaskReviewMutationLock(taskId, async () => {
    markEntered()
    await blocked
  })
  await entered
  const firstResult = first()
  const secondResult = second()
  releaseHolder()
  await holder
  return Promise.allSettled([firstResult, secondResult])
}

describe('RFC-057 — R1.approve-run', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc approved + run awaiting_review → run goes done + outputs upserted', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
      versionIndex: 3,
      reviewIteration: 2,
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: {
        rule: 'R1',
        docVersionId: dvId,
        reviewNodeRunId: reviewRunId,
        reviewNodeId: 'rev_1',
        actualStatus: 'awaiting_review',
      },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('done')

    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, reviewRunId))
    const ports = outputs.map((o) => o.portName).sort()
    expect(ports).toContain('approved_doc')
    expect(ports).toContain('approval_meta')

    const alert = await readAlert(h.db, alertId)
    expect(alert?.resolvedAt).not.toBeNull()
  })

  test('happy variant: terminal-non-done run + doc approved → still force-done via allowTerminal', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('done')
  })

  test('a retry fills approval_meta after a failure between the two output upserts', async () => {
    const seeded = await seedR1WriterCase('R1.approve-run')
    h = seeded.h
    let outputInsertCount = 0
    const flakyDb = new Proxy(h.db, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown
        if (property !== 'insert' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (...args: unknown[]) => {
          if (args[0] === nodeRunOutputs && ++outputInsertCount === 2) {
            throw new Error('injected failure before approval_meta upsert')
          }
          return Reflect.apply(value, target, args) as unknown
        }
      },
    }) as DbClient

    await expect(seeded.option.apply({ ...seeded.rc, db: flakyDb }, seeded.pre)).rejects.toThrow(
      'injected failure before approval_meta upsert',
    )
    expect(await readNodeRunStatus(h.db, seeded.reviewRunId)).toBe('awaiting_review')
    expect(
      (
        await h.db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, seeded.reviewRunId))
      ).map((row) => row.portName),
    ).toEqual(['approved_doc'])

    await seeded.option.apply(seeded.rc, seeded.pre)

    expect(await readNodeRunStatus(h.db, seeded.reviewRunId)).toBe('done')
    expect(
      (
        await h.db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, seeded.reviewRunId))
      )
        .map((row) => row.portName)
        .sort(),
    ).toEqual(['approval_meta', 'approved_doc'])
  })

  test('preflight-stale: run already done', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.approve-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.runAlreadyDone')
  })
})

describe('RFC-057 — R1.unapprove-doc', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc → pending, decided_at/by cleared; run untouched', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.unapprove-doc',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('awaiting_review')
    const dvAfter = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, dvId)).limit(1)
    )[0]!
    expect(dvAfter.decision).toBe('pending')
    expect(dvAfter.decidedAt).toBeNull()
    expect(dvAfter.decidedBy).toBeNull()
  })

  test('preflight-stale: doc not approved', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'pending',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.docNotApproved')
  })

  test('detail drift: docVersionId in alert points to deleted row', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: 'missing-doc-id', reviewNodeRunId: 'missing-run' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.detailDrift')
  })
})

describe('RFC-057 — R1.mark-task-failed', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: non-terminal task → failed', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.mark-task-failed',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'failed' } })
  })

  test('preflight-stale: task already terminal', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.taskTerminal')
  })

  test('destructive flag + high risk on mark-task-failed', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})

describe('RFC-057 — R1 writers vs task cancellation linearization', () => {
  let h: RepairHarness

  beforeEach(() => {
    registerTerminalTaskHook((db, taskId, to) => {
      sealOpenHumanGatesForTask(db, taskId, `task-${to}`)
    })
  })
  afterEach(async () => {
    registerTerminalTaskHook(null)
    await settleResumes()
    h?.cleanup()
  })

  test.each(['R1.approve-run', 'R1.unapprove-doc'] as const)(
    'cancel-first makes stale %s apply return 409 with zero doc/run/output writes',
    async (optionId) => {
      const seeded = await seedR1WriterCase(optionId)
      h = seeded.h
      // Preflight above deliberately happened before cancellation. Queue the
      // stale apply behind cancel to prove apply itself revalidates in-lock.
      const [cancelResult, repairResult] = await settleR1InOrder(
        h.taskId,
        () => cancelTask(h.db, h.taskId),
        () => seeded.option.apply(seeded.rc, seeded.pre),
      )

      expect(cancelResult.status).toBe('fulfilled')
      expect(repairResult.status).toBe('rejected')
      if (repairResult.status === 'rejected') {
        expect((repairResult.reason as { code?: string }).code).toBe('repair-preflight-stale')
      }
      expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
        'canceled',
      )
      expect(
        (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, seeded.reviewRunId)))[0]?.status,
      ).toBe('canceled')
      expect(
        (await h.db.select().from(docVersions).where(eq(docVersions.id, seeded.dvId)))[0]?.decision,
      ).toBe('approved')
      expect(
        await h.db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, seeded.reviewRunId)),
      ).toHaveLength(0)
    },
  )

  test.each(['R1.approve-run', 'R1.unapprove-doc'] as const)(
    '%s-first commits its complete fact set before cancel sweeps remaining open state',
    async (optionId) => {
      const seeded = await seedR1WriterCase(optionId)
      h = seeded.h
      const [repairResult, cancelResult] = await settleR1InOrder(
        h.taskId,
        () => seeded.option.apply(seeded.rc, seeded.pre),
        () => cancelTask(h.db, h.taskId),
      )

      expect(repairResult.status).toBe('fulfilled')
      expect(cancelResult.status).toBe('fulfilled')
      expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
        'canceled',
      )
      const run = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, seeded.reviewRunId))
      )[0]!
      const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, seeded.dvId)))[0]!
      const outputs = await h.db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, seeded.reviewRunId))
      if (optionId === 'R1.approve-run') {
        expect(run.status).toBe('done')
        expect(doc.decision).toBe('approved')
        expect(outputs.map((row) => row.portName).sort()).toEqual(['approval_meta', 'approved_doc'])
      } else {
        expect(run.status).toBe('canceled')
        expect(doc.decision).toBe('pending')
        expect(outputs).toHaveLength(0)
      }
    },
  )
})
