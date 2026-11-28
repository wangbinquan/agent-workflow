// RFC-626 §4.2 (plan T3): approving a plan again is idempotent, and the limit counts plans.
//
// Why this file exists: the automatic session recorded an evaluation every time it met a plan
// that awaited approval after the run had begun, and refused with `approval-retry-limit` once a
// run had three such records. A process killed between "evaluation recorded" and "approval in
// the journal" met the same plan again on its next start; three such kills refused an upgrade
// whose plan had never changed. Now one approval digest of one run is evaluated once and
// approved once — the records are reused — and the limit counts the DISTINCT approval digests
// that were re-approved. A run that keeps asking for the very approval it was given is stopped
// within the process instead.
import { afterEach, describe, expect, test } from 'bun:test'
import { persistEpochPlan } from '@/modules/system-operations/application/epochSwitch/planner'
import {
  readEpochPlan,
  withEpochOperation,
} from '@/modules/system-operations/application/epochSwitch/session'
import {
  AUTO_UPGRADE_REAPPROVAL_LIMIT,
  autoUpgradePlanRecords,
  type AutoUpgradeRecord,
} from '@/modules/system-operations/domain/epochSwitch/autoUpgrade'
import { createMigrationPlanDocument } from '@/modules/system-operations/domain/epochSwitch/documents'
import { directSwitchFixture, killed, type DirectSwitchFixture } from './helpers/rfc626DirectSwitch'

const fixtures: DirectSwitchFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close()
})
function fixture(): DirectSwitchFixture {
  const f = directSwitchFixture()
  fixtures.push(f)
  return f
}
const COMPLETE = ['intent', 'plan-evaluated', 'approved', 'plan-evaluated', 'approved', 'completed']
const reapprovals = async (f: DirectSwitchFixture) =>
  (await f.session()).records.filter(
    (record) => record.kind === 'plan-evaluated' && record.data.reapproval === true,
  )

describe('RFC-626 —— 会话对一份计划已经记下了什么', () => {
  const record = (
    kind: AutoUpgradeRecord['kind'],
    data: AutoUpgradeRecord['data'],
    index: number,
  ): AutoUpgradeRecord => ({
    version: 1,
    operationId: 'dbm_e2_records_fixture',
    sequence: index + 1,
    kind,
    at: index,
    data,
  })
  const session = {
    records: (
      [
        ['intent', { sessionSequence: 1 }],
        ['plan-evaluated', { runId: 'run-1', approvalDigest: 'a', reapproval: false }],
        ['approved', { runId: 'run-1', approvalDigest: 'a' }],
        ['plan-evaluated', { runId: 'run-1', approvalDigest: 'b', reapproval: true }],
        // Records of an earlier release: one evaluation per start for the same plan.
        ['plan-evaluated', { runId: 'run-1', approvalDigest: 'b', reapproval: true }],
        ['plan-evaluated', { runId: 'run-1', approvalDigest: 'b', reapproval: true }],
        ['plan-evaluated', { runId: 'run-2', approvalDigest: 'c', reapproval: true }],
        ['approved', { runId: 'run-2', approvalDigest: 'c' }],
      ] as const
    ).map(([kind, data], index) => record(kind, data, index)),
  }

  test('评估与批准按「运行 + 批准摘要」查；再批准的次数只数不同的摘要', () => {
    expect(autoUpgradePlanRecords(session, 'run-1', 'a')).toEqual({
      evaluated: true,
      approved: true,
      reapprovals: 1,
    })
    // Three evaluations of one plan are one re-approval.
    expect(autoUpgradePlanRecords(session, 'run-1', 'b')).toEqual({
      evaluated: true,
      approved: false,
      reapprovals: 1,
    })
    expect(autoUpgradePlanRecords(session, 'run-1', 'never seen')).toEqual({
      evaluated: false,
      approved: false,
      reapprovals: 1,
    })
    // Another run of the same session has its own count.
    expect(autoUpgradePlanRecords(session, 'run-2', 'c')).toEqual({
      evaluated: true,
      approved: true,
      reapprovals: 1,
    })
    expect(autoUpgradePlanRecords(session, 'run-2', 'a')).toEqual({
      evaluated: false,
      approved: false,
      reapprovals: 1,
    })
    expect(autoUpgradePlanRecords(session, 'run-3', 'a')).toEqual({
      evaluated: false,
      approved: false,
      reapprovals: 0,
    })
    expect(AUTO_UPGRADE_REAPPROVAL_LIMIT).toBe(3)
  })
})

describe('RFC-626 —— 同一份计划被杀多少次都只评估、批准一次', () => {
  test('在「评估已落盘、批准未落盘」之间被杀四次：不拒绝，记录不增加', async () => {
    const f = fixture()
    // The first death: right after the evaluation of the actual result was recorded.
    f.scenario.afterAppend = (kind, data) => {
      if (kind === 'plan-evaluated' && data.reapproval === true) throw killed()
    }
    expect(await f.start()).toMatchObject({ outcome: 'error', code: 'test-process-killed' })
    f.disarm()
    expect((await f.journal()).payload).toMatchObject({
      phase: 'validated',
      status: 'awaiting-approval',
    })
    expect(await f.recordKinds()).toEqual([
      'intent',
      'plan-evaluated',
      'approved',
      'plan-evaluated',
    ])

    // Three more: each start meets the same plan and dies before its approval is recorded.
    for (let death = 0; death < 3; death++) {
      f.scenario.beforeAppend = (kind) => {
        if (kind === 'approved') throw killed()
      }
      const result = await f.start()
      expect(result).toMatchObject({ outcome: 'error', code: 'test-process-killed' })
      expect(await reapprovals(f)).toHaveLength(1)
    }
    f.disarm()
    expect((await f.start()).outcome).toBe('done')
    expect(await f.recordKinds()).toEqual(COMPLETE)
    expect(await f.recordKinds()).not.toContain('refused')
    // The conversion was not repeated for any of it.
    expect(f.calls.prepare).toBe(1)
    expect(f.calls.finalize).toBe(1)
    expect(f.calls.validate).toBe(1)
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
  })

  test('在「批准已落盘、尚未写进日志」之间被杀四次：复用那条批准记录', async () => {
    const f = fixture()
    let approvals = 0
    // The first death: the approval of the actual result is recorded, the journal has not
    // heard of it.
    f.scenario.afterAppend = (kind) => {
      if (kind === 'approved' && ++approvals === 2) throw killed()
    }
    expect(await f.start()).toMatchObject({ outcome: 'error', code: 'test-process-killed' })
    f.disarm()
    const recorded = ['intent', 'plan-evaluated', 'approved', 'plan-evaluated', 'approved']
    expect(await f.recordKinds()).toEqual(recorded)
    const waiting = await f.journal()
    expect(waiting.payload.status).toBe('awaiting-approval')
    expect(waiting.payload.plan!.approvedDigest).toBeNull()

    for (let death = 0; death < 3; death++) {
      f.scenario.beforeRun = () => {
        throw killed()
      }
      expect(await f.start()).toMatchObject({ outcome: 'error', code: 'test-process-killed' })
      expect(await f.recordKinds()).toEqual(recorded)
      expect((await f.journal()).payload.plan!.approvedDigest).toBeNull()
    }
    f.disarm()
    expect((await f.start()).outcome).toBe('done')
    expect(await f.recordKinds()).toEqual(COMPLETE)
    const journal = await f.journal()
    expect(journal.payload.plan!.approvedDigest).toBe(journal.payload.plan!.approvalDigest)
    expect(journal.payload.approvals).toHaveLength(2)
  })

  test('上一次启动留下的评估记录在本次启动里同样复用（不是只在同一个进程里）', async () => {
    const f = fixture()
    f.killAt({ checkpoint: 'awaiting-approval' })
    expect((await f.start()).outcome).toBe('error')
    f.disarm()
    // Nothing of the actual result was evaluated yet.
    expect(await reapprovals(f)).toHaveLength(0)
    f.scenario.beforeAppend = (kind) => {
      if (kind === 'approved') throw killed()
    }
    expect((await f.start()).outcome).toBe('error')
    expect((await f.start()).outcome).toBe('error')
    expect(await reapprovals(f)).toHaveLength(1)
    f.disarm()
    expect((await f.start()).outcome).toBe('done')
    expect(await f.recordKinds()).toEqual(COMPLETE)
  })
})

describe('RFC-626 —— 次数上限只管实质不同的计划', () => {
  test('同一轮运行第四次拿出实质不同的计划时拒绝：前三份各评估、批准一次', async () => {
    const f = fixture()
    let runs = 0
    const result = await f.start({
      application: {
        ...f.app,
        async run() {
          runs++
          // A run that answers every approval with another, materially different plan.
          await withEpochOperation(f.deps, f.operationId, async (session) => {
            const p = session.journal.payload
            if (p.phase === 'planned') {
              await session.save({
                plan: {
                  ...p.plan!,
                  approvedDigest: p.plan!.approvalDigest,
                  approvedAt: session.now(),
                },
              })
              await session.save({ phase: 'backed-up' })
              await session.save({ phase: 'quiescing' })
              await session.save({ phase: 'frozen' })
            }
            const current = await readEpochPlan(session)
            await persistEpochPlan(
              session,
              createMigrationPlanDocument({
                ...current.payload,
                backup: { ...current.payload.backup, destination: `/backups/attempt-${runs}` },
              }),
              'frozen',
              true,
            )
          })
          return f.app.status({ operationId: f.operationId }) as ReturnType<typeof f.app.run>
        },
      },
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: f.operationId,
      code: 'approval-retry-limit',
    })
    expect(result.guidance[0]).toContain('requested approval more than three times')
    // The approved plan, then three re-approvals; the fourth different plan is the refusal.
    expect(runs).toBe(4)
    const asked = await reapprovals(f)
    expect(asked).toHaveLength(3)
    expect(new Set(asked.map((record) => record.data.approvalDigest)).size).toBe(3)
    const session = await f.session()
    expect(session.records.filter((record) => record.kind === 'approved')).toHaveLength(4)
    expect(session.records.at(-1)).toMatchObject({
      kind: 'refused',
      data: { reason: 'approval-retry-limit' },
    })
    expect(session.unfinished).toBe(true)
  })

  test('执行步反复索要它刚拿到的同一个批准：不新增评估记录，在本进程内四次之后拒绝', async () => {
    const f = fixture()
    let runs = 0
    const result = await f.start({
      application: {
        ...f.app,
        async run() {
          runs++
          await withEpochOperation(f.deps, f.operationId, async (session) => {
            const p = session.journal.payload
            if (p.phase === 'planned') {
              await session.save({
                plan: {
                  ...p.plan!,
                  approvedDigest: p.plan!.approvalDigest,
                  approvedAt: session.now(),
                },
              })
              await session.save({ phase: 'backed-up' })
              await session.save({ phase: 'quiescing' })
              await session.save({ phase: 'frozen', status: 'awaiting-approval' })
            } else await session.save({ status: 'awaiting-approval' })
          })
          return f.app.status({ operationId: f.operationId }) as ReturnType<typeof f.app.run>
        },
      },
    })
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 3, code: 'approval-retry-limit' })
    expect(runs).toBe(4)
    // The plan is the one evaluated before the run: it is not evaluated again.
    expect(await reapprovals(f)).toHaveLength(0)
    expect(await f.recordKinds()).toEqual(['intent', 'plan-evaluated', 'approved', 'refused'])
  })
})
