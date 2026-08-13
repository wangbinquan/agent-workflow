// RFC-297 T10 —— 清单组装 stage 的行为锁。
//
// 这个 stage 是「消费只写一份」的兑现处：它只认事件上的 `data.inventory` 载荷，
// 完全不知道 claude 有个 init 事件、opencode 有个 dump 文件。用例因此全部用
// **合成事件**驱动——如果哪天有人在这里加了一个 `if (runtime === …)`，第一条
// 用例就会失去意义，这本身就是信号。
//
// 另一半锁的是「没观测到」的三种归因不可混淆（design §2.3 / AC-5 / AC-6）：
// 运行时压根不产清单、本轮复用会话按设计不产、以及本该有却没有——只有最后一种
// 值得让用户看到告警，把前两种也算进去就会复活 RFC-280 P2-E 治过的噪音。

import { describe, expect, test } from 'bun:test'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { createInventoryStage } from '@/services/execution/inventoryStage'
import type { RuntimeDriverCapabilities } from '@/services/runtime/types'
import type { NormalizedEvent } from '@/services/runtime/types'
import type { DeclaredManifestV1 } from '@/services/execution/agentInjection'
import type { ObservedInventoryFaces } from '@agent-workflow/shared'

const caps = (over: Partial<RuntimeDriverCapabilities> = {}): RuntimeDriverCapabilities =>
  ({
    startupObservation: 'init-event',
    observationRequiresFreshRun: false,
    declarationFaces: {},
    inventory: {},
    ...over,
  }) as RuntimeDriverCapabilities

const declaredWith = (over: Partial<DeclaredManifestV1> = {}): DeclaredManifestV1 => ({
  ...emptyDeclaredManifest(),
  ...over,
})

const inventoryEvent = (faces: ObservedInventoryFaces, timestamp?: number): NormalizedEvent => ({
  kind: 'step_start',
  rawLine: '{"type":"system","subtype":"init"}',
  ...(timestamp === undefined ? {} : { timestamp }),
  data: { inventory: { faces } },
})

const plain = (): NormalizedEvent => ({ kind: 'text', rawLine: '{"type":"assistant"}' })

describe('组装与对账', () => {
  test('载荷 × 声明 → 三态来源，运行时无关', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ skills: ['mine'], subagents: ['helper'] }),
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(
      inventoryEvent(
        {
          skills: [
            { key: 'mine', name: 'mine' },
            { key: 'builtin', name: 'builtin' },
          ],
          agents: [{ key: 'other', name: 'other' }],
        },
        1000,
      ),
    )
    const result = stage.result()
    expect(result.state).toBe('captured')
    if (result.state !== 'captured') return
    expect(result.capturedAt).toBe(1000)
    expect(result.faces.skills?.map((e) => [e.key, e.provenance])).toEqual([
      ['builtin', 'ambient'],
      ['mine', 'injected'],
    ])
    // 声明了 helper 但运行时没报告 → 合成一条 declared-missing（与 banner 同源）。
    expect(result.faces.agents?.map((e) => [e.key, e.provenance])).toEqual([
      ['helper', 'declared-missing'],
      ['other', 'ambient'],
    ])
  })

  test('运行时未报告的面完全缺席结果，而不是变成空数组', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ plugins: ['p1'] }),
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(inventoryEvent({ skills: [] }))
    const result = stage.result()
    if (result.state !== 'captured') throw new Error('expected captured')
    expect(result.faces.skills).toEqual([])
    // 「没观测到 plugins」≠「plugins 一个都没加载」——后者才配显示成缺失。
    expect(result.faces.plugins).toBeUndefined()
  })

  test('tools 面 declared=null（本轮未约束工具集）→ 全 ambient，不产生缺失', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ tools: null }),
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(
      inventoryEvent({
        tools: [
          { key: 'Read', name: 'Read' },
          { key: 'Write', name: 'Write' },
        ],
      }),
    )
    const result = stage.result()
    if (result.state !== 'captured') throw new Error('expected captured')
    expect(result.faces.tools?.every((e) => e.provenance === 'ambient')).toBe(true)
  })

  test('只认第一份载荷（启动清单是一次性的）', () => {
    const stage = createInventoryStage({
      declared: declaredWith(),
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(inventoryEvent({ skills: [{ key: 'first', name: 'first' }] }, 1))
    stage.onEvent?.(inventoryEvent({ skills: [{ key: 'second', name: 'second' }] }, 2))
    const result = stage.result()
    if (result.state !== 'captured') throw new Error('expected captured')
    expect(result.faces.skills?.map((e) => e.key)).toEqual(['first'])
    expect(result.capturedAt).toBe(1)
  })

  test('不带载荷的普通事件被忽略', () => {
    const stage = createInventoryStage({
      declared: declaredWith(),
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(plain())
    expect(stage.result().state).toBe('unavailable')
  })
})

describe('「没观测到」的三种归因不可混淆', () => {
  test('运行时压根不产清单 → not-produced，不是故障', () => {
    const stage = createInventoryStage({
      declared: declaredWith(),
      capabilities: caps({ startupObservation: 'none' }),
      freshRun: true,
    })
    expect(stage.result()).toEqual({
      state: 'not-produced',
      reason: 'runtime-has-no-inventory',
    })
  })

  test('复用会话且该运行时的观测依赖 fresh run → not-produced（AC-6）', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ skills: ['s'] }),
      capabilities: caps({
        startupObservation: 'inventory-file',
        observationRequiresFreshRun: true,
      }),
      freshRun: false,
    })
    expect(stage.result()).toEqual({ state: 'not-produced', reason: 'session-reused' })
  })

  test('该有却没有 → unavailable（唯一值得告警的一种）', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ skills: ['s'] }),
      capabilities: caps({ startupObservation: 'init-event' }),
      freshRun: true,
    })
    expect(stage.result()).toEqual({ state: 'unavailable', reason: 'no-observation' })
  })

  test('fresh run 下即便运行时依赖 fresh run，缺观测仍算 unavailable', () => {
    const stage = createInventoryStage({
      declared: declaredWith({ skills: ['s'] }),
      capabilities: caps({
        startupObservation: 'inventory-file',
        observationRequiresFreshRun: true,
      }),
      freshRun: true,
    })
    expect(stage.result().state).toBe('unavailable')
  })
})

describe('stage 契约', () => {
  test('errorPolicy 是 isolate——清单挂了不该弄坏一次成功的 run（design §7.1）', () => {
    const stage = createInventoryStage({
      declared: declaredWith(),
      capabilities: caps(),
      freshRun: true,
    })
    expect(stage.errorPolicy).toBe('isolate')
  })

  test('零注入节点也能产出清单（AC-5 的 stage 侧）', () => {
    const stage = createInventoryStage({
      declared: declaredWith(), // 什么都没注入
      capabilities: caps(),
      freshRun: true,
    })
    stage.onEvent?.(inventoryEvent({ agents: [{ key: 'builtin', name: 'builtin' }] }, 7))
    const result = stage.result()
    if (result.state !== 'captured') throw new Error('expected captured')
    expect(result.faces.agents).toEqual([
      { key: 'builtin', name: 'builtin', provenance: 'ambient' },
    ])
  })
})
