// RFC-350 —— 收割编排的行为锁（注入假 persistence / kill / cancel，不碰数据库）。
//
// 为什么这些测试存在：收割是一条**不可逆**的动作链（杀进程 → 取消任务 → 覆盖原因 →
// 写审计）。这里钉死的不是「能收」，而是那些「不该发生的事一件都没发生」：
//   - 关着时一次 IO 都不发（AC-1）；
//   - 先杀后取消，且只杀要收割的那些任务的 run（AC-5）；
//   - 杀不掉（window-expired / kill-failed）**仍然**终结（AC-6 / 决策 D11）；
//   - cancel 抛错（竞态里已终态）不中断其余成员，也不吞掉原因写入（F-3）；
//   - 一棵树抛错不拖累下一棵（F-5）；
//   - 一棵都没收时不写日志汇总、不写审计（AC-8）；
//   - 单拍上限生效（F-7 / F-8）。
//
// 对应 design.md §9 的 T-8～T-14。

import { describe, expect, test } from 'bun:test'

import {
  MAX_TREES_PER_SWEEP,
  runTaskIdleTimeoutSweep,
} from '../src/modules/task-execution/application/taskIdleTimeoutReaper'
import type { TaskActivityRecord } from '../src/modules/task-execution/domain/idleTimeoutPolicy'
import type {
  IdleTimeoutAuditRecord,
  IdleTimeoutRunSnapshot,
  IdleTimeoutTreeSnapshot,
  TaskIdleTimeoutOperations,
} from '../src/modules/task-execution/application/ports/taskIdleTimeoutPersistence'
import type { StaleRunKillOutcome } from '../src/util/process'

const HOUR = 3_600_000
const NOW = 1_788_278_400_000
const IDLE_CONFIG = { enabled: true, idleHours: 24 }

interface Recorder {
  readonly calls: string[]
  readonly reasons: Array<{ taskId: string; summary: string; message: string }>
  readonly audits: IdleTimeoutAuditRecord[]
  readonly killed: string[]
}

function run(taskId: string, nodeRunId: string): IdleTimeoutRunSnapshot {
  return {
    nodeRunId,
    taskId,
    pid: 4242,
    startedAt: NOW - 2 * HOUR,
    spawnBinaryPath: '/usr/local/bin/opencode',
    spawnLaunchNonce: 'nonce',
  }
}

function member(
  taskId: string,
  status: TaskActivityRecord['status'],
  activityAt: number,
): TaskActivityRecord {
  return { taskId, status, activityAt }
}

function makeOperations(input: {
  trees: readonly IdleTimeoutTreeSnapshot[]
  killOutcome?: StaleRunKillOutcome | ((run: IdleTimeoutRunSnapshot) => StaleRunKillOutcome)
  cancelThrowsFor?: readonly string[]
  loadThrowsFor?: readonly string[]
  killThrows?: boolean
}): { operations: TaskIdleTimeoutOperations; recorder: Recorder } {
  const recorder: Recorder = { calls: [], reasons: [], audits: [], killed: [] }
  const byRoot = new Map(input.trees.map((tree) => [tree.rootTaskId, tree]))
  const operations: TaskIdleTimeoutOperations = {
    persistence: {
      async listIdleCandidateRoots(limit: number) {
        recorder.calls.push(`list:${limit}`)
        return input.trees.map((tree) => tree.rootTaskId).slice(0, limit)
      },
      async loadTreeActivity(rootTaskId: string) {
        recorder.calls.push(`load:${rootTaskId}`)
        if (input.loadThrowsFor?.includes(rootTaskId) === true) {
          throw new Error(`load blew up for ${rootTaskId}`)
        }
        return byRoot.get(rootTaskId) ?? null
      },
      async writeIdleTimeoutReason(reason) {
        recorder.calls.push(`reason:${reason.taskId}`)
        recorder.reasons.push({ ...reason })
      },
      async recordReapAudit(audit) {
        recorder.calls.push(`audit:${audit.taskId}`)
        recorder.audits.push(audit)
      },
    },
    async cancelTask(taskId: string) {
      recorder.calls.push(`cancel:${taskId}`)
      if (input.cancelThrowsFor?.includes(taskId) === true) {
        throw new Error(`task '${taskId}' is already terminal`)
      }
    },
    async killRunProcessTree(target: IdleTimeoutRunSnapshot) {
      recorder.calls.push(`kill:${target.nodeRunId}`)
      recorder.killed.push(target.nodeRunId)
      if (input.killThrows === true) throw new Error('ps blew up')
      const outcome = input.killOutcome ?? 'killed'
      return typeof outcome === 'function' ? outcome(target) : outcome
    },
  }
  return { operations, recorder }
}

/** 一棵静默了 40 小时、根 running、带一条活 run 的树。 */
function idleTree(rootTaskId: string, extra: Partial<IdleTimeoutTreeSnapshot> = {}) {
  return {
    rootTaskId,
    members: [member(rootTaskId, 'running', NOW - 40 * HOUR)],
    liveRuns: [run(rootTaskId, `${rootTaskId}-run`)],
    ...extra,
  } satisfies IdleTimeoutTreeSnapshot
}

describe('RFC-350 runTaskIdleTimeoutSweep', () => {
  test('T-13 关着时一次 IO 都不发（AC-1）', async () => {
    const { operations, recorder } = makeOperations({ trees: [idleTree('root')] })
    const result = await runTaskIdleTimeoutSweep(
      operations,
      { enabled: false, idleHours: 24 },
      { now: NOW },
    )
    expect(result).toEqual({ scanned: 0, reapedTrees: 0, reapedTasks: 0, skipped: 0 })
    expect(recorder.calls).toEqual([])
  })

  test('阈值为 0 同样一次 IO 都不发（配置层 min:1 之外的兜底）', async () => {
    const { operations, recorder } = makeOperations({ trees: [idleTree('root')] })
    await runTaskIdleTimeoutSweep(operations, { enabled: true, idleHours: 0 }, { now: NOW })
    expect(recorder.calls).toEqual([])
  })

  test('T-8 先杀进程树再取消，然后写原因与审计（AC-2 / AC-5）', async () => {
    const { operations, recorder } = makeOperations({ trees: [idleTree('root')] })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })

    expect(result).toEqual({ scanned: 1, reapedTrees: 1, reapedTasks: 1, skipped: 0 })
    expect(recorder.calls).toEqual([
      `list:${MAX_TREES_PER_SWEEP}`,
      'load:root',
      'kill:root-run',
      'cancel:root',
      'reason:root',
      'audit:root',
    ])
    expect(recorder.reasons[0]?.summary).toBe('task-idle-timeout')
    expect(recorder.audits[0]?.silentMs).toBe(40 * HOUR)
    expect(recorder.audits[0]?.thresholdMs).toBe(24 * HOUR)
    expect(recorder.audits[0]?.killOutcomes).toEqual({ killed: 1 })
  })

  test('T-8b 只杀要收割的任务的 run：已终态成员的历史 run 不碰', async () => {
    const tree: IdleTimeoutTreeSnapshot = {
      rootTaskId: 'root',
      members: [
        member('root', 'running', NOW - 40 * HOUR),
        member('settled', 'done', NOW - 40 * HOUR),
      ],
      liveRuns: [run('root', 'root-run'), run('settled', 'settled-run')],
    }
    const { operations, recorder } = makeOperations({ trees: [tree] })
    await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(recorder.killed).toEqual(['root-run'])
    expect(recorder.calls).not.toContain('cancel:settled')
  })

  test('T-8c 根先取消（利用 cancelTask 自带的父→子级联），其余成员随后补', async () => {
    const tree: IdleTimeoutTreeSnapshot = {
      rootTaskId: 'root',
      members: [
        member('child-a', 'running', NOW - 40 * HOUR),
        member('root', 'awaiting_human', NOW - 40 * HOUR),
        member('child-b', 'pending', NOW - 40 * HOUR),
      ],
      liveRuns: [],
    }
    const { operations, recorder } = makeOperations({ trees: [tree] })
    await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    const cancels = recorder.calls.filter((call) => call.startsWith('cancel:'))
    expect(cancels[0]).toBe('cancel:root')
    expect(cancels).toHaveLength(3)
  })

  test('T-9 杀不掉仍然终结，outcome 如实进审计（AC-6 / 决策 D11）', async () => {
    const { operations, recorder } = makeOperations({
      trees: [idleTree('root')],
      killOutcome: 'window-expired',
    })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(result.reapedTasks).toBe(1)
    expect(recorder.calls).toContain('cancel:root')
    expect(recorder.audits[0]?.killOutcomes).toEqual({ 'window-expired': 1 })
  })

  test('T-9b kill 抛异常也不阻断终结，记成 kill-failed', async () => {
    const { operations, recorder } = makeOperations({
      trees: [idleTree('root')],
      killThrows: true,
    })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(result.reapedTasks).toBe(1)
    expect(recorder.audits[0]?.killOutcomes).toEqual({ 'kill-failed': 1 })
  })

  test('T-10 cancel 抛错（竞态里已终态）不中断其余成员，原因照写（F-3）', async () => {
    const tree: IdleTimeoutTreeSnapshot = {
      rootTaskId: 'root',
      members: [
        member('root', 'running', NOW - 40 * HOUR),
        member('sibling', 'running', NOW - 40 * HOUR),
      ],
      liveRuns: [],
    }
    const { operations, recorder } = makeOperations({
      trees: [tree],
      cancelThrowsFor: ['root'],
    })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(result.reapedTasks).toBe(2)
    expect(recorder.reasons.map((r) => r.taskId).sort()).toEqual(['root', 'sibling'])
  })

  test('T-11 一棵树抛错不拖累下一棵，并计入 skipped（F-5）', async () => {
    const { operations, recorder } = makeOperations({
      trees: [idleTree('bad'), idleTree('good')],
      loadThrowsFor: ['bad'],
    })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(result).toEqual({ scanned: 2, reapedTrees: 1, reapedTasks: 1, skipped: 1 })
    expect(recorder.calls).toContain('cancel:good')
  })

  test('T-11b 树在扫描后消失（并发删除）⇒ 静默跳过，不算失败', async () => {
    const { operations, recorder } = makeOperations({ trees: [] })
    const gone: TaskIdleTimeoutOperations = {
      ...operations,
      persistence: {
        ...operations.persistence,
        async listIdleCandidateRoots() {
          return ['vanished']
        },
      },
    }
    const result = await runTaskIdleTimeoutSweep(gone, IDLE_CONFIG, { now: NOW })
    expect(result).toEqual({ scanned: 1, reapedTrees: 0, reapedTasks: 0, skipped: 0 })
    expect(recorder.calls).not.toContain('cancel:vanished')
  })

  test('T-12 一棵都没收时不写任何原因 / 审计（AC-8）', async () => {
    const fresh: IdleTimeoutTreeSnapshot = {
      rootTaskId: 'root',
      members: [member('root', 'running', NOW - 1 * HOUR)],
      liveRuns: [run('root', 'root-run')],
    }
    const { operations, recorder } = makeOperations({ trees: [fresh] })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(result).toEqual({ scanned: 1, reapedTrees: 0, reapedTasks: 0, skipped: 0 })
    expect(recorder.reasons).toEqual([])
    expect(recorder.audits).toEqual([])
    expect(recorder.killed).toEqual([])
  })

  test('T-14 单拍上限传给 persistence，可被调用方收窄（F-7 / F-8）', async () => {
    const trees = Array.from({ length: 5 }, (_, i) => idleTree(`root-${i}`))
    const { operations, recorder } = makeOperations({ trees })
    const result = await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW, maxTrees: 2 })
    expect(recorder.calls[0]).toBe('list:2')
    expect(result.reapedTrees).toBe(2)
  })

  test('默认上限就是 MAX_TREES_PER_SWEEP', async () => {
    const { operations, recorder } = makeOperations({ trees: [] })
    await runTaskIdleTimeoutSweep(operations, IDLE_CONFIG, { now: NOW })
    expect(recorder.calls[0]).toBe(`list:${MAX_TREES_PER_SWEEP}`)
    expect(MAX_TREES_PER_SWEEP).toBe(20)
  })
})
