// RFC-117 — filterSelectableRuntimes is the testable core of useRuntimesList,
// shared by the AgentForm runtime picker and the settings runtime selectors
// (distiller / commit / fusion). Locks the RFC-118 disabled-filter + the
// "keep the already-selected runtime even if disabled" rule (RFC-118 D6) —
// so the settings pickers can't drift from the agent picker.
//
// flag-audit §8 决策（用户 2026-07-07）：`claudeCodeEnabled` 配置门删除后，
// claude 可用性由注册表派生（hasEnabledClaudeRuntime），过滤器不再有
// claude-protocol 整体闸——per-runtime `enabled` 是唯一开关，D6「钉住值永不
// 隐藏」对 claude 行同样统一生效（旧行为里被配置门例外掉）。

import { describe, expect, test } from 'vitest'
import { filterSelectableRuntimes, hasEnabledClaudeRuntime } from '../src/hooks/useRuntimesList'

const RT = (name: string, protocol: string, enabled: boolean) => ({ name, protocol, enabled })

const ALL = [
  RT('opencode', 'opencode', true),
  RT('claude-code', 'claude-code', true),
  RT('oc-haiku', 'opencode', true),
  RT('oc-old', 'opencode', false), // disabled
]

describe('filterSelectableRuntimes (RFC-117 / RFC-118)', () => {
  test('keeps enabled runtimes; drops disabled', () => {
    const names = filterSelectableRuntimes(ALL, null).map((r) => r.name)
    expect(names).toEqual(['opencode', 'claude-code', 'oc-haiku'])
    expect(names).not.toContain('oc-old')
  })

  test('keeps a disabled runtime when it is the current selection (RFC-118 D6)', () => {
    const names = filterSelectableRuntimes(ALL, 'oc-old').map((r) => r.name)
    expect(names).toContain('oc-old')
  })

  test('a DISABLED claude runtime is dropped by its own enabled flag（无整体 claude 闸）', () => {
    const withDisabledClaude = [...ALL, RT('cc-fork', 'claude-code', false)]
    const names = filterSelectableRuntimes(withDisabledClaude, null).map((r) => r.name)
    expect(names).not.toContain('cc-fork')
  })

  test('a pinned disabled claude runtime stays visible — D6 现在对 claude 行统一生效', () => {
    // 配置门时代它被整体闸例外掉；门删除后与其他 runtime 一致：钉住值永不隐藏
    //（后端本就允许保留已钉住的 disabled runtime）。
    const withDisabledClaude = [...ALL, RT('cc-fork', 'claude-code', false)]
    const names = filterSelectableRuntimes(withDisabledClaude, 'cc-fork').map((r) => r.name)
    expect(names).toContain('cc-fork')
  })
})

describe('hasEnabledClaudeRuntime（配置门的注册表继任者）', () => {
  test('存在 enabled 的 claude-protocol 行 → true', () => {
    expect(hasEnabledClaudeRuntime(ALL)).toBe(true)
  })

  test('claude 行全 disabled / 不存在 / 注册表为空 → false', () => {
    expect(
      hasEnabledClaudeRuntime([RT('cc', 'claude-code', false), RT('oc', 'opencode', true)]),
    ).toBe(false)
    expect(hasEnabledClaudeRuntime([RT('oc', 'opencode', true)])).toBe(false)
    expect(hasEnabledClaudeRuntime([])).toBe(false)
  })
})
