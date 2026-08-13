// RFC-297 T19/T20 —— 统一读端。
//
// 锁的第一件事就是用户实证的那个 bug：**Claude Code 运行时下清单恒空**，并且
// 文案是「未生成清单文件（插件可能加载失败）」——claude 根本没有那个插件。修法
// 不是给 claude 补一个插件，而是让读端按各运行时自己的观测源取数：opencode 读
// RFC-029 dump 快照，claude 读 `system/init` 报告（存在启动验证记录里）。
//
// 第二件事是**统一不许让 opencode 掉字段**（AC-2）：它今天显示的 mode/model/
// path/description/type/hint/plugins 一列都不能少。这里逐字段断言。

import { describe, expect, test } from 'bun:test'
import {
  facesFromOpencodeSnapshot,
  facesFromStartupObservation,
  assembleFaces,
} from '@/services/execution/inventoryRead'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import type { InventorySnapshotCaptured, StartupObservation } from '@agent-workflow/shared'

const opencodeSnapshot = (): InventorySnapshotCaptured => ({
  captured: true,
  schemaVersion: 1,
  capturedAt: 1700000000,
  agents: [
    {
      name: 'auditor',
      mode: 'subagent',
      modelProviderId: 'anthropic',
      modelId: 'claude-x',
      source: 'inline',
    },
  ],
  skills: [{ name: 'lint', source: 'managed', path: '/skills/lint', description: 'lints' }],
  mcps: [{ name: 'rag', type: 'local', status: 'connected', hint: null }],
  plugins: [{ specifier: 'file:///p/aw-inventory-dump.mjs', source: 'inline' }],
})

const claudeObservation = (): Extract<StartupObservation, { state: 'verified' }> => ({
  state: 'verified',
  source: 'claude-init',
  mcpServers: [
    { name: 'rag', status: 'connected' },
    { name: 'broken', status: 'failed' },
  ],
  tools: ['Read', 'Write'],
  agents: ['auditor', 'general-purpose'],
  skills: ['lint'],
})

describe('opencode：富字段一个都不许丢（AC-2）', () => {
  test('快照的每个字段都出现在统一形状里', () => {
    const faces = facesFromOpencodeSnapshot(opencodeSnapshot())
    expect(faces.agents).toEqual([
      {
        key: 'auditor',
        name: 'auditor',
        mode: 'subagent',
        modelProviderId: 'anthropic',
        modelId: 'claude-x',
        source: 'inline',
      },
    ])
    expect(faces.skills).toEqual([
      {
        key: 'lint',
        name: 'lint',
        source: 'managed',
        path: '/skills/lint',
        description: 'lints',
      },
    ])
    expect(faces.mcps).toEqual([
      { key: 'rag', name: 'rag', type: 'local', status: 'connected', hint: null },
    ])
    // plugins 的面内唯一键是 specifier（它没有单独的 name）。
    expect(faces.plugins).toEqual([
      {
        key: 'file:///p/aw-inventory-dump.mjs',
        name: 'file:///p/aw-inventory-dump.mjs',
        source: 'inline',
      },
    ])
  })

  test('tools 面缺席而非空数组——opencode 的插件不枚举工具集', () => {
    // 空数组会被读成「一个工具都没加载」，那是完全不同的一句话。
    expect(facesFromOpencodeSnapshot(opencodeSnapshot()).tools).toBeUndefined()
  })
})

describe('claude：init 报告转成同一形状', () => {
  test('四个面齐全，mcps 保留运行时原文状态', () => {
    const faces = facesFromStartupObservation(claudeObservation())
    expect(faces.agents?.map((a) => a.key)).toEqual(['auditor', 'general-purpose'])
    expect(faces.skills?.map((s) => s.key)).toEqual(['lint'])
    expect(faces.tools?.map((t) => t.key)).toEqual(['Read', 'Write'])
    expect(faces.mcps).toEqual([
      { key: 'rag', name: 'rag', status: 'connected' },
      { key: 'broken', name: 'broken', status: 'failed' },
    ])
  })

  test('claude 不报告的富字段一律缺席，不伪造空值', () => {
    const faces = facesFromStartupObservation(claudeObservation())
    for (const item of faces.agents ?? []) {
      expect(item.mode).toBeUndefined()
      expect(item.modelId).toBeUndefined()
      expect(item.source).toBeUndefined()
    }
    for (const item of faces.skills ?? []) {
      expect(item.path).toBeUndefined()
      expect(item.description).toBeUndefined()
    }
  })

  test('plugins 面缺席——claude 协议上没有插件概念', () => {
    expect(facesFromStartupObservation(claudeObservation()).plugins).toBeUndefined()
  })
})

describe('对账：两条路共用同一份来源判据', () => {
  test('declared 里的算 injected，其余算 ambient，缺的合成 declared-missing', () => {
    const declared = {
      ...emptyDeclaredManifest(),
      skills: ['lint', 'never-loaded'],
      subagents: ['auditor'],
      mcpServers: ['rag', 'broken'],
    }
    const faces = assembleFaces(facesFromStartupObservation(claudeObservation()), declared)
    expect(faces.skills?.map((s) => [s.key, s.provenance])).toEqual([
      ['lint', 'injected'],
      ['never-loaded', 'declared-missing'],
    ])
    expect(faces.agents?.map((a) => [a.key, a.provenance])).toEqual([
      ['auditor', 'injected'],
      // 平台没注入过它——运行时自带的内建子代理。
      ['general-purpose', 'ambient'],
    ])
    // 注入了但没连上：仍是 injected（它到场了，只是状态不健康），状态自身承载问题。
    expect(faces.mcps?.find((m) => m.key === 'broken')?.provenance).toBe('injected')
  })

  test('declared 缺失（存量行）→ 全部 ambient，不臆造归属', () => {
    const faces = assembleFaces(facesFromOpencodeSnapshot(opencodeSnapshot()), null)
    expect(faces.agents?.every((a) => a.provenance === 'ambient')).toBe(true)
    expect(faces.skills?.every((s) => s.provenance === 'ambient')).toBe(true)
    // 且不产生任何 declared-missing——没有声明记录就无从谈缺失。
    expect(
      Object.values(faces)
        .flat()
        .some((e) => e.provenance === 'declared-missing'),
    ).toBe(false)
  })

  test('tools 未被约束（declared.tools === null）→ 全 ambient 且无缺失', () => {
    const faces = assembleFaces(facesFromStartupObservation(claudeObservation()), {
      ...emptyDeclaredManifest(),
      tools: null,
    })
    expect(faces.tools?.every((t) => t.provenance === 'ambient')).toBe(true)
  })
})
