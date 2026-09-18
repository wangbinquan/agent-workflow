// LOCKS: RFC-057 — R1 repair options (approved doc_version but review run not done).
// 3 options × 3 cases = 9 tests.

import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '../src/db/schema'
import { createRepairEngine } from './helpers/repairEngine'
import { describeEachProvider } from './helpers/eachProvider'
import { cancelViaEngine } from './helpers/cancelEngine'
import { sealOpenHumanGatesForTask } from '../src/services/terminalSweep'
import { createHumanGateTerminalSweepCommand } from '../src/modules/collaboration/infrastructure/humanGateTerminalSweep'
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
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'

type R1WriterId = 'R1.approve-run' | 'R1.unapprove-doc'

interface R1WriterCase {
  h: RepairHarness
  reviewRunId: string
  dvId: string
  optionId: R1WriterId
  alertId: string
}

/**
 * RFC-359 AC-1（第 8 刀）：这三条并发 / 重试用例原来直接驱动 classic 实现的内部
 * （`R1_OPTIONS[].preflight` / `.apply` + 手搓的 `RepairContext`）。合并后只剩一份实现，
 * 它们改走**公开入口**——断言的本来就是用户可见的结果（409 且零写入、完整事实集先落库），
 * 不是「在锁里第几步重验」这种实现内部结构。
 */
async function seedR1WriterCase(
  db: ProviderNeutralDatabase,
  optionId: R1WriterId,
): Promise<R1WriterCase> {
  const h = await buildHarness(db, { taskStatus: 'awaiting_review' })
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
  return { h, reviewRunId, dvId, optionId, alertId }
}

describeEachProvider('RFC-057 — R1.approve-run', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc approved + run awaiting_review → run goes done + outputs upserted', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
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
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: 'u-1',
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
    h = await buildHarness(provider.db, { taskStatus: 'failed' })
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
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('done')
  })

  test('a crash mid-apply leaves zero half-written outputs; the retry writes the complete set', async () => {
    const seeded = await seedR1WriterCase(provider.db, 'R1.approve-run')
    h = seeded.h
    let outputInsertCount = 0
    // 故障注入要**递归到事务句柄**：两个引擎里这段写都在一笔事务里发生，只包最外层句柄的话
    // PostgreSQL 那条腿根本注入不进去（本用例第一版就是这么假绿的）。
    const injectFailure = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(inner, property) {
          const value = Reflect.get(inner, property, inner) as unknown
          if (typeof value !== 'function') return value
          if (property === 'transaction') {
            return (callback: (tx: object) => unknown, ...rest: unknown[]) =>
              Reflect.apply(value, inner, [
                (tx: object) => callback(injectFailure(tx)),
                ...rest,
              ]) as unknown
          }
          if (property !== 'insert') return value.bind(inner)
          return (...args: unknown[]) => {
            if (args[0] === nodeRunOutputs && ++outputInsertCount === 2) {
              throw new Error('injected failure before approval_meta upsert')
            }
            return Reflect.apply(value, inner, args) as unknown
          }
        },
      }) as T
    const flakyDb = injectFailure(h.db) as ProviderNeutralDatabase
    // 崩在两次 output upsert 之间：对同一个库另建一台引擎，句柄换成会炸的那个。
    const flaky = createRepairEngine(flakyDb, { appHome: h.tmpDir })

    await expect(
      flaky.applyRepairOption({
        taskId: h.taskId,
        alertId: seeded.alertId,
        optionId: 'R1.approve-run',
        actorUserId: null,
      }),
    ).rejects.toThrow('injected failure before approval_meta upsert')
    expect(await readNodeRunStatus(h.db, seeded.reviewRunId)).toBe('awaiting_review')
    // RFC-359 AC-1（第 8 刀）：**崩在两次 upsert 之间不留半成品**。合并前那份实现不在事务里
    // 写，于是崩完库里躺着一个只有 `approved_doc` 的评审 run——运维看到的是「批准了但没有
    // 批准元数据」的中间态。留下的这份把整个 apply 放在一笔事务里，崩了就整笔回滚。
    expect(
      (
        await h.db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, seeded.reviewRunId))
      ).map((row) => row.portName),
    ).toEqual([])

    await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId: seeded.alertId,
      optionId: 'R1.approve-run',
      actorUserId: null,
    })

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
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
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
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'R1.approve-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.runAlreadyDone')
  })
})

describeEachProvider('RFC-057 — R1.unapprove-doc', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc → pending, decided_at/by cleared; run untouched', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
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
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'R1.unapprove-doc',
      actorUserId: null,
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
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
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
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.docNotApproved')
  })

  test('detail drift: docVersionId in alert points to deleted row', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: 'missing-doc-id', reviewNodeRunId: 'missing-run' },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.detailDrift')
  })
})

describeEachProvider('RFC-057 — R1.mark-task-failed', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: non-terminal task → failed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
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
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'R1.mark-task-failed',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'failed' } })
  })

  test('preflight-stale: task already terminal', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
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
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.taskTerminal')
  })

  test('destructive flag + high risk on mark-task-failed', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1' },
    })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})

describeEachProvider('RFC-057 — R1 writers vs task cancellation linearization', (provider) => {
  let h: RepairHarness
  let uninstallAfterCommitPump: (() => void) | null = null

  afterEach(async () => {
    uninstallAfterCommitPump?.()
    uninstallAfterCommitPump = null
    await settleResumes()
    h?.cleanup()
  })

  test.each(['R1.approve-run', 'R1.unapprove-doc'] as const)(
    'a %s clicked after the task was canceled refuses and writes nothing',
    async (optionId) => {
      const seeded = await seedR1WriterCase(provider.db, optionId)
      h = seeded.h
      uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(h.db, {
        onTerminalTask(db, taskId, to) {
          void sealOpenHumanGatesForTask(
            createHumanGateTerminalSweepCommand(db),
            taskId,
            `task-${to}`,
          )
        },
      })
      // 运维那一侧真实发生的次序：别人刚把任务取消掉，诊断面板上的那个按钮还在，点下去。
      await cancelViaEngine(h.db, h.taskId)

      let code: string | undefined
      try {
        await h.engine.applyRepairOption({
          taskId: h.taskId,
          alertId: seeded.alertId,
          optionId,
          actorUserId: 'r1-cancel-then-repair',
        })
      } catch (error) {
        code = (error as { code?: string }).code
      }
      expect(code, '已取消的任务上点修复必须被拒，而不是把它改回去').toBe('repair-preflight-stale')

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
        '被拒的修复一行都不该写',
      ).toHaveLength(0)
    },
  )

  test.each(['R1.approve-run', 'R1.unapprove-doc'] as const)(
    'a %s that already committed survives a later cancellation sweep',
    async (optionId) => {
      const seeded = await seedR1WriterCase(provider.db, optionId)
      h = seeded.h
      uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(h.db, {
        onTerminalTask(db, taskId, to) {
          void sealOpenHumanGatesForTask(
            createHumanGateTerminalSweepCommand(db),
            taskId,
            `task-${to}`,
          )
        },
      })
      // 反过来的次序：修复先落库，随后任务被取消——取消的清扫不该把修复刚写下的事实抹掉。
      await h.engine.applyRepairOption({
        taskId: h.taskId,
        alertId: seeded.alertId,
        optionId,
        actorUserId: 'r1-repair-then-cancel',
      })
      await cancelViaEngine(h.db, h.taskId)

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
        expect(run.status, '已经 done 的评审 run 不该被取消清扫拉走').toBe('done')
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
