// RFC-310 T19 —— configuration upgrade pure diff planner 测试。
//
// 锁：①逐类 pin 变化被逐条列出（employee/policy/template/verification/adapter）；
// ②noop 升级零失效；③任一 pin 变化使全部未发布在途产物进入失效清单（不做
// 「只失效相关半径」的聪明事——design §12.1 要求整体 repin）；④纯函数重放
// 稳定（canonical 场景下两次调用深相等）。

import { describe, expect, test } from 'bun:test'

import {
  planConfigurationUpgrade,
  type InFlightWork,
  type PinnedClosure,
} from '@/modules/development-automation/engine/policy/configUpgradePlanner'

const BASE: PinnedClosure = {
  employee: { id: 'emp-java', revision: 3 },
  policy: { id: 'pol-default', revision: 7 },
  templates: {
    'change.implement': { id: 'tpl-java', revision: 4 },
    'mr.feedback.apply': { id: 'tpl-feedback', revision: 2 },
  },
  verificationProfiles: { 'vp-maven': 5 },
  adapters: { 'adp-req': 1 },
}

const IN_FLIGHT: InFlightWork = {
  unpublishedActionRunRefs: ['run-1'],
  unpublishedCandidateRefs: ['cand-1'],
  pendingDecisionRefs: ['dec-9'],
  analysisReceiptRefs: ['ana-2'],
}

describe('rfc310 config upgrade planner', () => {
  test('noop when closures are identical; nothing invalidated', () => {
    const plan = planConfigurationUpgrade({ current: BASE, next: BASE, inFlight: IN_FLIGHT })
    expect(plan.noop).toBe(true)
    expect(plan.changes).toEqual([])
    expect(plan.invalidates.unpublishedActionRunRefs).toEqual([])
  })

  test('every changed pin is listed once, per kind, with from/to labels', () => {
    const next: PinnedClosure = {
      employee: { id: 'emp-java', revision: 4 },
      policy: { id: 'pol-default', revision: 7 },
      templates: {
        'change.implement': { id: 'tpl-java', revision: 5 },
        'pipeline.repair': { id: 'tpl-pipe', revision: 1 },
      },
      verificationProfiles: { 'vp-maven': 6 },
      adapters: {},
    }
    const plan = planConfigurationUpgrade({ current: BASE, next, inFlight: IN_FLIGHT })
    expect(plan.noop).toBe(false)
    expect(plan.changes).toEqual([
      { kind: 'employee', from: 'emp-java@3', to: 'emp-java@4' },
      { kind: 'template', capabilityId: 'change.implement', from: 'tpl-java@4', to: 'tpl-java@5' },
      { kind: 'template', capabilityId: 'mr.feedback.apply', from: 'tpl-feedback@2', to: null },
      { kind: 'template', capabilityId: 'pipeline.repair', from: null, to: 'tpl-pipe@1' },
      { kind: 'verification-profile', profileId: 'vp-maven', from: 5, to: 6 },
      { kind: 'adapter', adapterId: 'adp-req', from: 1, to: null },
    ])
    expect(plan.invalidates).toEqual(IN_FLIGHT)
  })

  test('policy-only change still invalidates the whole in-flight set', () => {
    const next: PinnedClosure = { ...BASE, policy: { id: 'pol-default', revision: 8 } }
    const plan = planConfigurationUpgrade({ current: BASE, next, inFlight: IN_FLIGHT })
    expect(plan.changes).toEqual([{ kind: 'policy', from: 'pol-default@7', to: 'pol-default@8' }])
    expect(plan.invalidates.pendingDecisionRefs).toEqual(['dec-9'])
  })

  test('deterministic: repeated calls produce deeply equal plans', () => {
    const next: PinnedClosure = { ...BASE, employee: null }
    const a = planConfigurationUpgrade({ current: BASE, next, inFlight: IN_FLIGHT })
    const b = planConfigurationUpgrade({ current: BASE, next, inFlight: IN_FLIGHT })
    expect(a).toEqual(b)
    expect(a.changes[0]).toEqual({ kind: 'employee', from: 'emp-java@3', to: null })
  })
})
