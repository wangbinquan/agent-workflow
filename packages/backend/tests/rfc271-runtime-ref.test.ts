// RFC-271 T6d —— `RuntimeRef` 收口后的**失败归属**回归。
//
// 设计门 R7-P1-5 的要害：scheduler 三处 agentId 裸读**看起来一样、实测不同**。
// 把它们收成一个 resolver 时，最容易悄悄改掉的就是这个差异：
//
//   位点            缺 agentId              查不到 agent 行
//   主派发          节点失败                 节点失败
//                   agent-identity-missing    agent-not-found
//   fanout hydrate  静默跳过（continue）      静默跳过（continue）
//
// 而且 resolver **不能 throw**：直接 throw 会被 `runScope` 冒泡成任务级
// "scheduler error"，把 node/wrapper 级归属整个丢掉。
//
// 这个文件锁 resolver 本身的行为契约；三处调用点的映射由
// `rfc223-pr2-refs.test.ts` 的源码收口断言 + 既有 e2e 套覆盖。

import { describe, expect, test } from 'bun:test'
import { DISPATCH_CALL_POLICY, FANOUT_HYDRATE_CALL_POLICY } from '@agent-workflow/shared'
import {
  agentRefOfNode,
  fanoutInnerAgentRefKey,
  resolveNodeAgentRef,
} from '@/services/ref/runtimeRef'

/** 只回答 getAgentById 的最小 db 桩——resolver 不该碰别的。 */
const stubDb = (rows: Record<string, unknown>) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(Object.values(rows)),
        }),
      }),
    }),
  }) as never

describe('agentRefOfNode —— 唯一读取点', () => {
  test('有 agentId 时解出 id 变体', () => {
    expect(agentRefOfNode({ agentId: '01JAGENT' })).toEqual({
      k: 'id',
      type: 'agent',
      id: '01JAGENT',
    })
  })

  test('缺席 / 空串 / 非字符串一律 null（fail closed）', () => {
    expect(agentRefOfNode({})).toBeNull()
    expect(agentRefOfNode({ agentId: '' })).toBeNull()
    expect(agentRefOfNode({ agentId: 123 })).toBeNull()
    expect(agentRefOfNode({ agentId: null })).toBeNull()
  })

  test('**绝不**从 agentName 回退 —— 那正是 RFC-223 要根除的', () => {
    expect(agentRefOfNode({ agentName: 'auditor' } as never)).toBeNull()
  })
})

describe('fanoutInnerAgentRefKey —— canonical dedup key', () => {
  test('key 就是 agentId；name-only 节点返回 null 并 fail closed', () => {
    expect(fanoutInnerAgentRefKey({ agentId: '01JA' })).toBe('01JA')
    expect(fanoutInnerAgentRefKey({ agentName: 'a' } as never)).toBeNull()
  })

  test('两个同名不同 id 的 inner 节点得到不同的 key（绝不塌成一个）', () => {
    expect(fanoutInnerAgentRefKey({ agentId: '01JA' })).not.toBe(
      fanoutInnerAgentRefKey({ agentId: '01JB' }),
    )
  })
})

describe('resolveNodeAgentRef —— typed Result，绝不 throw', () => {
  test('缺 agentId → reason:missing（调用点据此报 agent-identity-missing）', async () => {
    const r = await resolveNodeAgentRef(stubDb({}), {}, DISPATCH_CALL_POLICY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing')
  })

  test('有 id 但查不到行 → reason:unreadable（调用点据此报 agent-not-found）', async () => {
    const r = await resolveNodeAgentRef(stubDb({}), { agentId: '01JGHOST' }, DISPATCH_CALL_POLICY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreadable')
  })

  test('两种失败是**不同的 reason** —— 合并它们会让两个错误码塌成一个', async () => {
    const missing = await resolveNodeAgentRef(stubDb({}), {}, DISPATCH_CALL_POLICY)
    const unreadable = await resolveNodeAgentRef(
      stubDb({}),
      { agentId: '01JGHOST' },
      DISPATCH_CALL_POLICY,
    )
    expect(missing.ok).toBe(false)
    expect(unreadable.ok).toBe(false)
    if (!missing.ok && !unreadable.ok) expect(missing.reason).not.toBe(unreadable.reason)
  })

  test('两种 call policy 走同一条解析、**返回形状一致**——分支在调用点不在这里', async () => {
    const dispatch = await resolveNodeAgentRef(stubDb({}), {}, DISPATCH_CALL_POLICY)
    const hydrate = await resolveNodeAgentRef(stubDb({}), {}, FANOUT_HYDRATE_CALL_POLICY)
    expect(dispatch).toEqual(hydrate)
  })

  test('任何输入都不 throw（runScope 会把异常冒泡成任务级 scheduler error）', async () => {
    for (const node of [{}, { agentId: '' }, { agentId: 123 }, { agentId: '01J' }]) {
      await expect(
        resolveNodeAgentRef(stubDb({}), node as never, DISPATCH_CALL_POLICY),
      ).resolves.toBeDefined()
    }
  })
})

describe('两处 call policy 的归属声明（实测差异，不是笔误）', () => {
  test('主派发归 node、fanout hydrate 归 wrapper 且静默跳过', () => {
    expect(DISPATCH_CALL_POLICY.onMissing).toBe('fail')
    expect(DISPATCH_CALL_POLICY.failureOwner).toBe('node')
    expect(FANOUT_HYDRATE_CALL_POLICY.onMissing).toBe('skip')
    expect(FANOUT_HYDRATE_CALL_POLICY.failureOwner).toBe('wrapper')
  })
})
