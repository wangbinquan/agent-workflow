// RFC-310 T12 —— DecisionReceipt canonical core 与 replay oracle（design.md §4.6）。
//
// 可回放性的字节合同：`canonicalDigest` 只覆盖
// policy/employee/facts/work-set/guard trace/rule trace/selected decision 的
// canonical core；receipt id 与 decidedAt 不参与——时钟与数据库 id 不得混进
// 确定性结论。replay oracle 直接比较 core 的 canonical bytes。

import { canonicalDigest, canonicalStringify } from '../../domain/canonicalJson'
import type { NextDecision } from '../../domain/decision'
import type { GuardTraceNode, RuleTraceNode } from './evaluatePolicy'

export interface DecisionCanonicalCore {
  readonly policyRef: string
  readonly employeeRef: string | null
  readonly factDigest: string
  readonly workSetDigest: string | null
  readonly guardTrace: readonly GuardTraceNode[]
  readonly ruleTrace: readonly RuleTraceNode[]
  readonly selected: NextDecision
}

export function canonicalDecisionBytes(core: DecisionCanonicalCore): string {
  return canonicalStringify(core)
}

export function canonicalDecisionDigest(core: DecisionCanonicalCore): string {
  return canonicalDigest(core)
}

export interface ReplayMismatch {
  readonly iteration: number
  readonly expected: string
  readonly observed: string
}

/**
 * replay oracle：同一纯函数跑 N 次，canonical bytes 必须逐字节相同。
 * 返回第一处 mismatch（null = 确定性成立）。metrics 面要求 mismatch 恒 0。
 */
export function replayOracle(
  evaluate: () => DecisionCanonicalCore,
  iterations: number,
): ReplayMismatch | null {
  const expected = canonicalDecisionBytes(evaluate())
  for (let i = 1; i < iterations; i += 1) {
    const observed = canonicalDecisionBytes(evaluate())
    if (observed !== expected) return { iteration: i, expected, observed }
  }
  return null
}
