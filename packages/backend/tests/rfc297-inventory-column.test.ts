// RFC-297 T17/T18/T19 —— 清单观测的落库与读回。
//
// 本文件锁的是 AC-5：**零注入节点也要看得见清单**。
//
// 此前 claude 侧这类节点的观测随作用域直接丢弃——观测只在
// `declaredHasContent(declared)` 为真时才随启动验证记录落库，而「没挂任何技能/
// MCP/子代理」的节点 declared 全空，于是「这一轮到底加载了什么」永远无从查起。
// 现在观测与验证分离：验证回答「我注入的东西生效了吗」（没注入就无从谈起，仍受
// 门控），清单回答「这一轮加载了什么」（谁都想知道，无条件落库）。
//
// 另一半锁「没观测到」的三种归因不可混为一谈——混了就会复活 RFC-280 P2-E 治过的
// 「每个 followup 都报无法验证」噪音。

import { describe, expect, test } from 'bun:test'
import { buildRuntimeInventoryObservation } from '@/services/execution/inventoryObservation'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import type { DeclaredManifestV1 } from '@/services/execution/agentInjection'
import type { RuntimeDriverCapabilities } from '@/services/runtime/types'
import type { InventorySnapshot } from '@agent-workflow/shared'

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

const claudeInit = {
  tools: ['Read', 'Write'],
  agents: ['auditor', 'general-purpose'],
  skills: ['lint'],
  mcpServers: [{ name: 'rag', status: 'connected' }],
}

describe('AC-5：零注入节点也有清单', () => {
  test('declared 全空 + 有观测 → captured，四个面齐全', () => {
    const observation = buildRuntimeInventoryObservation({
      capabilities: caps(),
      freshRun: true,
      declared: declaredWith(), // 什么都没注入
      claudeInit,
      snapshot: null,
      now: 1700,
    })
    expect(observation.state).toBe('captured')
    if (observation.state !== 'captured') return
    expect(observation.capturedAt).toBe(1700)
    expect(observation.faces.tools?.map((t) => t.key)).toEqual(['Read', 'Write'])
    expect(observation.faces.agents?.map((a) => a.key)).toEqual(['auditor', 'general-purpose'])
    // 平台什么都没注入 → 运行时报告的一切都是它自带的。
    expect(
      Object.values(observation.faces)
        .flat()
        .every((e) => e.provenance === 'ambient'),
    ).toBe(true)
  })

  test('有注入时来源对账照常（injected / ambient / declared-missing）', () => {
    const observation = buildRuntimeInventoryObservation({
      capabilities: caps(),
      freshRun: true,
      declared: declaredWith({ skills: ['lint', 'never-loaded'], subagents: ['auditor'] }),
      claudeInit,
      snapshot: null,
      now: 1,
    })
    if (observation.state !== 'captured') throw new Error('expected captured')
    expect(observation.faces.skills?.map((s) => [s.key, s.provenance])).toEqual([
      ['lint', 'injected'],
      ['never-loaded', 'declared-missing'],
    ])
    expect(observation.faces.agents?.find((a) => a.key === 'general-purpose')?.provenance).toBe(
      'ambient',
    )
  })
})

describe('opencode 的快照走同一条组装', () => {
  const captured: InventorySnapshot = {
    captured: true,
    schemaVersion: 1,
    capturedAt: 42,
    agents: [
      {
        name: 'coder',
        mode: 'primary',
        modelProviderId: 'anthropic',
        modelId: 'x',
        source: 'inline',
      },
    ],
    skills: [{ name: 'lint', source: 'managed', path: '/s', description: 'd' }],
    mcps: [{ name: 'rag', type: 'local', status: 'connected', hint: null }],
    plugins: [{ specifier: 'file:///p.mjs', source: 'inline' }],
  }

  test('富字段一个不少（AC-2），且快照优先于 init 观测', () => {
    const observation = buildRuntimeInventoryObservation({
      capabilities: caps({
        startupObservation: 'inventory-file',
        observationRequiresFreshRun: true,
      }),
      freshRun: true,
      declared: declaredWith({ subagents: ['coder'] }),
      claudeInit, // 同时给了 init 观测：快照该赢（这是 opencode 的运行时）
      snapshot: captured,
      now: 9,
    })
    if (observation.state !== 'captured') throw new Error('expected captured')
    expect(observation.faces.agents?.[0]).toMatchObject({
      key: 'coder',
      mode: 'primary',
      modelId: 'x',
      provenance: 'injected',
    })
    expect(observation.faces.skills?.[0]).toMatchObject({ path: '/s', description: 'd' })
    expect(observation.faces.plugins?.[0]?.key).toBe('file:///p.mjs')
    // tools 面缺席：dump 插件不枚举工具集（缺席 ≠ 加载了 0 个）。
    expect(observation.faces.tools).toBeUndefined()
  })
})

describe('「没观测到」的三种归因不可混淆', () => {
  test('运行时压根不产清单 → not-produced', () => {
    expect(
      buildRuntimeInventoryObservation({
        capabilities: caps({ startupObservation: 'none' }),
        freshRun: true,
        declared: declaredWith(),
        claudeInit: null,
        snapshot: null,
        now: 0,
      }),
    ).toEqual({ state: 'not-produced', reason: 'runtime-has-no-inventory', message: null })
  })

  test('followup 复用会话且观测依赖 fresh run → not-produced（不是故障，AC-6）', () => {
    expect(
      buildRuntimeInventoryObservation({
        capabilities: caps({
          startupObservation: 'inventory-file',
          observationRequiresFreshRun: true,
        }),
        freshRun: false,
        declared: declaredWith({ skills: ['s'] }),
        claudeInit: null,
        snapshot: null,
        now: 0,
      }),
    ).toEqual({ state: 'not-produced', reason: 'session-reused', message: null })
  })

  test('该有却没有 → unavailable（唯一值得注意的一种）', () => {
    expect(
      buildRuntimeInventoryObservation({
        capabilities: caps(),
        freshRun: true,
        declared: declaredWith({ skills: ['s'] }),
        claudeInit: null,
        snapshot: null,
        now: 0,
      }),
    ).toEqual({ state: 'unavailable', reason: 'no-observation', message: null })
  })

  test('opencode 的失败桩原样呈现其 reason 与诊断详情', () => {
    const observation = buildRuntimeInventoryObservation({
      capabilities: caps({
        startupObservation: 'inventory-file',
        observationRequiresFreshRun: true,
      }),
      freshRun: true,
      declared: declaredWith({ skills: ['s'] }),
      claudeInit: null,
      snapshot: {
        captured: false,
        reason: 'dump-plugin-internal-error',
        message: 'agents() call threw',
      },
      now: 0,
    })
    expect(observation).toEqual({
      state: 'unavailable',
      reason: 'dump-plugin-internal-error',
      message: 'agents() call threw',
    })
  })

  test('快照坏了 → malformed（与「压根没有」区分开）', () => {
    const observation = buildRuntimeInventoryObservation({
      capabilities: caps({
        startupObservation: 'inventory-file',
        observationRequiresFreshRun: true,
      }),
      freshRun: true,
      declared: declaredWith({ skills: ['s'] }),
      claudeInit: null,
      snapshot: { captured: false, reason: 'parse-failed', message: null },
      now: 0,
    })
    expect(observation.state).toBe('malformed')
  })
})
