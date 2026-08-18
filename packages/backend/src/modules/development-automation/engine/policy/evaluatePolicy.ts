// RFC-310 T11 —— 固定 guard + first-match 规则解释器（design.md §4.3/§4.4/§4.5）。
//
// 纯函数：同一 (guard 输入 + FactSnapshot + 规则集) 永远得到同一 decision 与
// trace（AC-1 的执行半边；canonical 字节与 replay oracle 在 canonicalTrace.ts）。
// policy 不是最高权力：十二步 fixed guard 全过之后才轮到用户规则；无匹配 =
// blocked(no-policy-match)，绝不把「下一步」交还 Agent。规则求值遇到
// indeterminate（unknown/stale fact）立即停机 → 映射 collect/block，不允许
// 落到后续 fallback 规则（provider outage 不得改变动作优先级）。

import { evaluatePredicate, factLeaf, type MissionFactSnapshot } from '../../domain/facts'
import type { NextDecision } from '../../domain/decision'
import type { FactPredicate } from '../../domain/predicate'

/** §4.3 十二步里 1–10 的 typed 输入：由 reconciler（PR-2）从聚合投影。 */
export interface FixedGuardInput {
  readonly missionTerminal: boolean
  readonly mrTerminal: 'active' | 'merged' | 'closed' | 'not-applicable'
  readonly holdsLease: boolean
  readonly activeWritableAction: boolean
  readonly unsettledEffect: boolean
  readonly transitionFence: 'none' | 'cancel-pending' | 'handoff-pending'
  readonly factIntegrityViolations: readonly string[]
  readonly staleBaseline: boolean
  readonly authorityViolations: readonly string[]
  readonly exhaustedBudgets: readonly string[]
  readonly automationMode: 'active' | 'tracking-only'
  readonly uploadSeed: 'not-applicable' | 'pending' | 'seeded' | 'published'
  readonly uploadPlanRef: string | null
}

export interface GuardTraceNode {
  readonly guard: string
  readonly outcome: 'pass' | 'stop'
  readonly detail: string | null
}

export interface RuleTraceNode {
  readonly ruleId: string
  readonly matched: boolean
  readonly stoppedOn: string | null
}

export interface PolicyRule {
  readonly ruleId: string
  readonly when: readonly FactPredicate[]
  readonly decision: NextDecision
}

export interface PolicyEvaluation {
  readonly selected: NextDecision
  readonly selectedBy: 'guard' | 'rule' | 'no-match'
  readonly matchedRuleId: string | null
  readonly guardTrace: readonly GuardTraceNode[]
  readonly ruleTrace: readonly RuleTraceNode[]
}

const COLLECT_BY_GROUP: Record<string, NextDecision | undefined> = {
  repository: { kind: 'collect-repository-facts' },
  mr: { kind: 'collect-mr-facts' },
  requirement: undefined, // requirement 的 collect 需要 adapterBindingRef，交 block/collect 由上层重派
  pipeline: undefined, // gateKeys 需要上下文，同上——用 block 显式暴露而不是造假参数
  action: undefined,
  budget: undefined,
}

function collectDecisionFor(factId: string): NextDecision {
  const spec = factLeaf(factId)
  const collectable = spec !== undefined ? (COLLECT_BY_GROUP[spec.group] ?? null) : null
  if (collectable !== null && collectable !== undefined) return collectable
  return { kind: 'block', reason: `fact-unavailable:${factId}` }
}

/** 固定 guard 序列（§4.3 1–10）；返回 null 表示放行到规则层。 */
function runFixedGuards(input: FixedGuardInput): {
  readonly trace: GuardTraceNode[]
  readonly decision: NextDecision | null
} {
  const trace: GuardTraceNode[] = []
  const stop = (guard: string, decision: NextDecision, detail: string | null = null) => {
    trace.push({ guard, outcome: 'stop', detail })
    return { trace, decision }
  }
  const pass = (guard: string) => {
    trace.push({ guard, outcome: 'pass', detail: null })
  }

  if (input.missionTerminal || input.mrTerminal === 'merged' || input.mrTerminal === 'closed') {
    return stop('terminal', {
      kind: 'mark-terminal',
      terminal:
        input.mrTerminal === 'merged'
          ? 'merged'
          : input.mrTerminal === 'closed'
            ? 'closed-unmerged'
            : 'canceled',
    })
  }
  pass('terminal')

  if (!input.holdsLease)
    return stop('lease-epoch', {
      kind: 'wait',
      reason: 'not-current-writer',
      resumeAt: null,
      wakeSources: ['timer'],
      attemptOrdinal: 0,
    })
  pass('lease-epoch')

  if (input.activeWritableAction || input.unsettledEffect || input.transitionFence !== 'none') {
    return stop('active-effect-transition', {
      kind: 'wait',
      reason:
        input.transitionFence !== 'none'
          ? `transition-${input.transitionFence}`
          : input.activeWritableAction
            ? 'active-action-running'
            : 'effect-unsettled',
      resumeAt: null,
      wakeSources: ['manual', 'timer'],
      attemptOrdinal: 0,
    })
  }
  pass('active-effect-transition')

  if (input.factIntegrityViolations.length > 0) {
    return stop(
      'fact-integrity',
      { kind: 'block', reason: `fact-integrity:${input.factIntegrityViolations[0]!}` },
      input.factIntegrityViolations.join(','),
    )
  }
  pass('fact-integrity')

  if (input.staleBaseline) {
    return stop('freshness', { kind: 'collect-mr-facts' }, 'baseline-stale')
  }
  pass('freshness')

  if (input.authorityViolations.length > 0) {
    return stop(
      'authority',
      { kind: 'block', reason: `authority:${input.authorityViolations[0]!}` },
      input.authorityViolations.join(','),
    )
  }
  pass('authority')

  if (input.exhaustedBudgets.length > 0) {
    return stop(
      'budget',
      { kind: 'block', reason: `budget-exhausted:${input.exhaustedBudgets[0]!}` },
      input.exhaustedBudgets.join(','),
    )
  }
  pass('budget')

  // safety guard：merge/approve/resolve/force-push 在类型层不存在（closed
  // union），这里只留 trace 节点表达「已检查」。
  pass('safety')

  if (input.automationMode === 'tracking-only') {
    return stop('automation-mode', {
      kind: 'wait',
      reason: 'tracking-only',
      resumeAt: null,
      wakeSources: ['webhook', 'pipeline', 'timer', 'manual'],
      attemptOrdinal: 0,
    })
  }
  pass('automation-mode')

  if (input.uploadSeed === 'pending') {
    if (input.uploadPlanRef === null) {
      return stop('upload-fulfillment', { kind: 'block', reason: 'upload-plan-ref-missing' })
    }
    return stop('upload-fulfillment', {
      kind: 'seed-repository-uploads',
      uploadPlanRef: input.uploadPlanRef as never,
    })
  }
  pass('upload-fulfillment')

  return { trace, decision: null }
}

/** §4.3 完整序列：guards → first-match → fallback。纯函数、无 IO、无时钟。 */
export function evaluatePolicy(input: {
  readonly guards: FixedGuardInput
  readonly snapshot: MissionFactSnapshot
  readonly rules: readonly PolicyRule[]
}): PolicyEvaluation {
  const { trace: guardTrace, decision: guardDecision } = runFixedGuards(input.guards)
  if (guardDecision !== null) {
    return {
      selected: guardDecision,
      selectedBy: 'guard',
      matchedRuleId: null,
      guardTrace,
      ruleTrace: [],
    }
  }

  const ruleTrace: RuleTraceNode[] = []
  for (const rule of input.rules) {
    let matched = true
    let stoppedOn: string | null = null
    for (const predicate of rule.when) {
      const result = evaluatePredicate(input.snapshot, predicate)
      if (result.value === 'indeterminate') {
        // indeterminate ⇒ 停机 collect/block；绝不跳到后续规则。
        ruleTrace.push({ ruleId: rule.ruleId, matched: false, stoppedOn: result.indeterminateFact })
        return {
          selected: collectDecisionFor(result.indeterminateFact ?? 'unknown'),
          selectedBy: 'guard',
          matchedRuleId: null,
          guardTrace,
          ruleTrace,
        }
      }
      if (result.value === false) {
        matched = false
        stoppedOn = null
        break
      }
    }
    ruleTrace.push({ ruleId: rule.ruleId, matched, stoppedOn })
    if (matched) {
      return {
        selected: rule.decision,
        selectedBy: 'rule',
        matchedRuleId: rule.ruleId,
        guardTrace,
        ruleTrace,
      }
    }
  }

  return {
    selected: { kind: 'block', reason: 'no-policy-match' },
    selectedBy: 'no-match',
    matchedRuleId: null,
    guardTrace,
    ruleTrace,
  }
}
