// RFC-366 —— 蒸馏准入判据的纯函数锁。
//
// 这个文件同时是 `proposal.md §6 能力影响清单` 的执行证据：C1–C7 每一条被关闭的
// 既有能力，这里都有一条对应的**拒绝分支**用例。CLAUDE.md §RFC workflow 第 7 条
// 要求能力收缩型 RFC 的每条禁用分支都有测试覆盖——RFC-224 的教训是「新路径不再
// 继承旧能力」这种收缩最容易悄悄发生，因为没有任何正向用例会红。
//
// 判定顺序本身也在这里钉住：它决定审计日志里记哪个 reason，而 reason 是管理员
// 排查「为什么这个任务没提炼」时唯一的线索。

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DISTILL_POLICY,
  DISTILL_SOURCE_CONFIG_KEY,
  DISTILL_SOURCE_KINDS,
  resolveDistillPolicy,
  type DistillSourceKind,
  type TaskLaunchOrigin,
} from '@agent-workflow/shared'
import {
  distillAdmission,
  type DistillTaskFacts,
} from '../src/modules/memory/domain/distillAdmission'

const MANUAL_TASK: DistillTaskFacts = {
  launchOrigin: 'manual',
  catalogVisibility: 'public',
  spaceKind: 'remote',
}

function task(overrides: Partial<DistillTaskFacts> = {}): DistillTaskFacts {
  return { ...MANUAL_TASK, ...overrides }
}

function admit(input: {
  sourceKind?: DistillSourceKind
  task?: DistillTaskFacts | null
  origins?: readonly TaskLaunchOrigin[]
  sources?: Partial<Record<DistillSourceKind, boolean>>
}) {
  return distillAdmission({
    sourceKind: input.sourceKind ?? 'agent-run',
    task: input.task === undefined ? MANUAL_TASK : input.task,
    policy: {
      launchOrigins: input.origins ?? DEFAULT_DISTILL_POLICY.launchOrigins,
      sources: { ...DEFAULT_DISTILL_POLICY.sources, ...(input.sources ?? {}) },
    },
  })
}

describe('RFC-366 distill admission — 放行面', () => {
  test('默认策略下，手工任务的五类源全部放行', () => {
    for (const kind of DISTILL_SOURCE_KINDS) {
      expect(admit({ sourceKind: kind })).toEqual({ admitted: true })
    }
  })

  test('无任务的事件放行——task_id 可空是 schema 允许的形态，不能变成隐式拒绝', () => {
    expect(admit({ task: null })).toEqual({ admitted: true })
  })

  test('把某个来源加进白名单后，该来源的任务即放行', () => {
    expect(
      admit({ task: task({ launchOrigin: 'scheduled' }), origins: ['manual', 'scheduled'] }),
    ).toEqual({ admitted: true })
  })

  test('inherited / scratch / local 空间不是内部执行，照常放行', () => {
    for (const spaceKind of ['inherited', 'scratch', 'local'] as const) {
      expect(admit({ task: task({ spaceKind }) })).toEqual({ admitted: true })
    }
  })
})

describe('RFC-366 distill admission — 逐源开关（D9）', () => {
  // 五条：每一类源被关掉时都必须真的不入队。
  for (const kind of DISTILL_SOURCE_KINDS) {
    test(`关掉 ${kind} 开关后该源被拒`, () => {
      expect(admit({ sourceKind: kind, sources: { [kind]: false } })).toEqual({
        admitted: false,
        reason: 'source-disabled',
      })
    })
  }

  test('关掉一类源不影响其余四类', () => {
    for (const kind of DISTILL_SOURCE_KINDS) {
      for (const other of DISTILL_SOURCE_KINDS) {
        if (other === kind) continue
        expect(admit({ sourceKind: other, sources: { [kind]: false } })).toEqual({ admitted: true })
      }
    }
  })
})

describe('RFC-366 distill admission — 任务来源白名单（D2 / 能力影响清单 C1–C6）', () => {
  // C1–C3：定时任务里的 review / clarify / feedback，默认不再提炼。
  for (const kind of ['review', 'clarify', 'feedback'] as const) {
    test(`C1–C3：scheduled 任务的 ${kind} 默认被拒`, () => {
      expect(admit({ sourceKind: kind, task: task({ launchOrigin: 'scheduled' }) })).toEqual({
        admitted: false,
        reason: 'launch-origin-not-allowed',
      })
    })
  }

  // C4 / C5 / C6：webhook / event / api 三种来源默认被拒。
  for (const origin of ['webhook', 'event', 'api'] as const) {
    test(`C4–C6：${origin} 任务默认被拒（五类源同判）`, () => {
      for (const kind of DISTILL_SOURCE_KINDS) {
        expect(admit({ sourceKind: kind, task: task({ launchOrigin: origin }) })).toEqual({
          admitted: false,
          reason: 'launch-origin-not-allowed',
        })
      }
    })
  }

  test('空白名单拒绝一切带任务的事件', () => {
    expect(admit({ origins: [] })).toEqual({
      admitted: false,
      reason: 'launch-origin-not-allowed',
    })
  })
})

describe('RFC-366 distill admission — 内部任务硬拒（D7 / 能力影响清单 C7）', () => {
  test('catalogVisibility=internal 被拒', () => {
    expect(admit({ task: task({ catalogVisibility: 'internal' }) })).toEqual({
      admitted: false,
      reason: 'internal-task',
    })
  })

  test('spaceKind=internal 被拒（融合等 internalSource 启动走的是这一条）', () => {
    expect(admit({ task: task({ spaceKind: 'internal' }) })).toEqual({
      admitted: false,
      reason: 'internal-task',
    })
  })

  test('内部任务即便来源在白名单里也照拒——它没有开关可恢复', () => {
    expect(
      admit({
        task: task({ launchOrigin: 'manual', catalogVisibility: 'internal' }),
        origins: ['manual', 'scheduled', 'event', 'webhook', 'api'],
      }),
    ).toEqual({ admitted: false, reason: 'internal-task' })
  })
})

describe('RFC-366 distill admission — 判定顺序即契约', () => {
  test('源开关关闭 + 来源不在白名单 → reason 是 source-disabled', () => {
    expect(
      admit({
        sourceKind: 'agent-run',
        task: task({ launchOrigin: 'scheduled' }),
        sources: { 'agent-run': false },
      }),
    ).toEqual({ admitted: false, reason: 'source-disabled' })
  })

  test('内部任务 + 来源不在白名单 → reason 是 internal-task', () => {
    expect(
      admit({ task: task({ launchOrigin: 'scheduled', catalogVisibility: 'internal' }) }),
    ).toEqual({ admitted: false, reason: 'internal-task' })
  })

  test('源开关关闭 + 内部任务 → reason 仍是 source-disabled（开关最先判）', () => {
    expect(
      admit({
        sourceKind: 'task-run',
        task: task({ catalogVisibility: 'internal' }),
        sources: { 'task-run': false },
      }),
    ).toEqual({ admitted: false, reason: 'source-disabled' })
  })
})

describe('RFC-366 policy 解析（D2 / D9 / D10 的默认值）', () => {
  test('空配置 ≡ 仅 manual + 五源全开 + 60s 去抖', () => {
    const policy = resolveDistillPolicy({})
    expect(policy.launchOrigins).toEqual(['manual'])
    expect(policy.agentRunDebounceMs).toBe(60_000)
    for (const kind of DISTILL_SOURCE_KINDS) expect(policy.sources[kind]).toBe(true)
  })

  test('省略的开关键 ≡ true —— 存量配置不会因为新增源而静默关掉任何东西', () => {
    const policy = resolveDistillPolicy({ memoryDistillSources: { agentRun: false } })
    expect(policy.sources['agent-run']).toBe(false)
    expect(policy.sources['task-run']).toBe(true)
    expect(policy.sources.clarify).toBe(true)
  })

  test('DISTILL_SOURCE_CONFIG_KEY 是 DB 字面值 ↔ 配置键的唯一映射', () => {
    expect(DISTILL_SOURCE_CONFIG_KEY).toEqual({
      clarify: 'clarify',
      review: 'review',
      feedback: 'feedback',
      'agent-run': 'agentRun',
      'task-run': 'taskRun',
    })
    // 少一项就意味着某个源的开关永远读不到——读出来是 undefined ?? true。
    expect(Object.keys(DISTILL_SOURCE_CONFIG_KEY).sort()).toEqual([...DISTILL_SOURCE_KINDS].sort())
  })
})
