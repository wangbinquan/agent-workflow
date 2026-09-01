// RFC-108 T19 (AR-04) — closed detect→classify→auto-repair loop (default OFF).
//
// 为什么这条测试存在：auto-repair loop 一旦开启，绝不能在「真人工选择」间瞎猜，也不能碰
// 未启用规则/已隔离任务。本测试用注入的 resolveOptions/applyOption 直接锁定 loop 逻辑：
// ① 启用规则 + 恰一个 eligible+available → 应用 + 记 auto-repair 事件；② 未启用规则 → 跳，
// 不调 apply；③ 两个 eligible → 跳（no-single-eligible）；④ 已隔离任务 → 跳；⑤ apply 抛错
// → 跳、不计 repaired。

import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { lifecycleAlerts, tasks, workflows } from '../src/db/schema'
import { runAutoRepairOnce } from '../src/services/autoRepair'
import { __clearDriverLeasesForTest } from '../src/services/driverLease'
import { listRecoveryEventsForTask, __resetRecoveryCountersForTest } from '../src/services/recovery'
import { recordAutoRecoveryAttempt } from '../src/services/recoveryBreaker'
import type { RepairOption } from '@agent-workflow/shared'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BREAKER = { maxPerWindow: 3, windowMs: 60 * 60 * 1000 }

afterEach(() => {
  __clearDriverLeasesForTest()
  __resetRecoveryCountersForTest()
})

function mkOption(id: string, autoApplyEligible: boolean, available: boolean): RepairOption {
  return {
    id,
    rule: 'S4',
    labelKey: 'l',
    descriptionKey: 'd',
    risk: 'low',
    destructive: false,
    autoApplyEligible,
    available,
    previewSteps: [],
  }
}

async function seedTaskWithAlert(db: DbClient, rule = 'S4'): Promise<string> {
  const wfId = ulid()
  const taskId = ulid()
  const def = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
  await db.insert(workflows).values({ id: wfId, name: 'w', definition: JSON.stringify(def) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await db.insert(lifecycleAlerts).values({
    id: ulid(),
    taskId,
    rule,
    severity: 'warning',
    detail: '{}',
    detectedAt: Date.now(),
  })
  return taskId
}

const enableAll = () => true

describe('RFC-108 T19 — auto-repair loop', () => {
  test('enabled rule + exactly one eligible+available → applies + records event', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskWithAlert(db)
    const operations = taskRecoveryOperations(db)
    const applied: string[] = []
    const res = await runAutoRepairOnce({
      operations,
      breaker: BREAKER,
      isRuleEnabled: enableAll,
      resolveOptions: async () => [
        mkOption('S4.kick-task', true, true),
        mkOption('S4.cancel-task', false, true),
      ],
      applyOption: async (_a, optionId) => {
        applied.push(optionId)
        return { outcome: 'success' }
      },
    })
    expect(res.repaired).toHaveLength(1)
    expect(res.repaired[0]!.optionId).toBe('S4.kick-task')
    expect(applied).toEqual(['S4.kick-task'])
    expect(
      (await listRecoveryEventsForTask(operations, taskId)).some((e) => e.kind === 'auto-repair'),
    ).toBe(true)
  })

  test('disabled rule → skipped, applyOption never called', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTaskWithAlert(db)
    const operations = taskRecoveryOperations(db)
    let applyCalled = false
    const res = await runAutoRepairOnce({
      operations,
      breaker: BREAKER,
      isRuleEnabled: () => false,
      resolveOptions: async () => [mkOption('S4.kick-task', true, true)],
      applyOption: async () => {
        applyCalled = true
        return { outcome: 'success' }
      },
    })
    expect(res.repaired).toHaveLength(0)
    expect(res.skipped[0]!.reason).toBe('rule-disabled')
    expect(applyCalled).toBe(false)
  })

  test('two eligible+available options → no-single-eligible, not applied', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTaskWithAlert(db)
    const operations = taskRecoveryOperations(db)
    const res = await runAutoRepairOnce({
      operations,
      breaker: BREAKER,
      isRuleEnabled: enableAll,
      resolveOptions: async () => [mkOption('a', true, true), mkOption('b', true, true)],
      applyOption: async () => ({ outcome: 'success' }),
    })
    expect(res.repaired).toHaveLength(0)
    expect(res.skipped[0]!.reason).toBe('no-single-eligible')
  })

  test('quarantined task → skipped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskWithAlert(db)
    const operations = taskRecoveryOperations(db)
    for (let i = 0; i < 4; i++) {
      await recordAutoRecoveryAttempt(operations, taskId, BREAKER, 1000)
    }
    const res = await runAutoRepairOnce({
      operations,
      breaker: BREAKER,
      isRuleEnabled: enableAll,
      resolveOptions: async () => [mkOption('S4.kick-task', true, true)],
      applyOption: async () => ({ outcome: 'success' }),
    })
    expect(res.repaired).toHaveLength(0)
    expect(res.skipped[0]!.reason).toBe('quarantined')
  })

  test('applyOption throws → skipped, not counted as repaired', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTaskWithAlert(db)
    const operations = taskRecoveryOperations(db)
    const res = await runAutoRepairOnce({
      operations,
      breaker: BREAKER,
      isRuleEnabled: enableAll,
      resolveOptions: async () => [mkOption('S4.kick-task', true, true)],
      applyOption: async () => {
        throw new Error('apply-failed')
      },
    })
    expect(res.repaired).toHaveLength(0)
    expect(res.skipped[0]!.reason).toBe('apply-failed-or-lease-held')
  })
})
