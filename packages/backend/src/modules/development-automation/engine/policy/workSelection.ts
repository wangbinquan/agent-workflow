// RFC-310 T11 —— WorkSelectionReceipt 与两层确定性选择（design.md §4.4/§3.8）。
//
// action rule 只选 capability；平台用固定 selector + policy 参数生成精确
// work set（Agent 不能自行挑掉难处理的评论/错误）。员工选择与模板路由是
// 另一组纯函数：explicit > assignment > selection-policy first-match，每级
// 0/1 个结果，多义与无 fallback 都是显式阻断。

import { canonicalDigest } from '../../domain/canonicalJson'
import { evaluatePredicate, type MissionFactSnapshot } from '../../domain/facts'
import type { FactPredicate } from '../../domain/predicate'

// ---------------------------------------------------------------- work sets

export interface WorkSelectionReceipt {
  readonly capabilityId: string
  readonly inputFactDigest: string
  readonly orderingRuleId: string
  readonly itemRefs: readonly string[]
  readonly digest: string
}

function receipt(
  capabilityId: string,
  inputFactDigest: string,
  orderingRuleId: string,
  itemRefs: readonly string[],
): WorkSelectionReceipt {
  return {
    capabilityId,
    inputFactDigest,
    orderingRuleId,
    itemRefs,
    digest: canonicalDigest({ capabilityId, inputFactDigest, orderingRuleId, itemRefs }),
  }
}

export interface FeedbackWorkItem {
  readonly threadRef: string
  readonly revision: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly createdOrdinal: number
}

/** feedback：按 (authorClass 优先级, createdOrdinal, threadRef) 稳定排序 + 批量上限。 */
export function selectFeedbackWorkSet(input: {
  readonly items: readonly FeedbackWorkItem[]
  readonly allowedAuthorClasses: readonly ('human' | 'bot' | 'self')[]
  readonly batchLimit: number
  readonly inputFactDigest: string
}): WorkSelectionReceipt {
  const rank: Record<string, number> = { human: 0, bot: 1, self: 2 }
  const selected = input.items
    .filter((item) => input.allowedAuthorClasses.includes(item.authorClass))
    .sort(
      (a, b) =>
        rank[a.authorClass]! - rank[b.authorClass]! ||
        a.createdOrdinal - b.createdOrdinal ||
        (a.threadRef < b.threadRef ? -1 : 1),
    )
    .slice(0, input.batchLimit)
    .map((item) => `${item.threadRef}@${item.revision}`)
  return receipt(
    'mr.feedback.apply',
    input.inputFactDigest,
    'feedback/author-class-then-created@1',
    selected,
  )
}

export interface PipelineWorkItem {
  readonly gateKey: string
  readonly required: boolean
  readonly status: string
  readonly failureCategories: readonly string[]
}

/** pipeline repair：只取 required+fail，按 (第一失败类别, gateKey) 排序。 */
export function selectPipelineWorkSet(input: {
  readonly gates: readonly PipelineWorkItem[]
  readonly batchLimit: number
  readonly inputFactDigest: string
}): WorkSelectionReceipt {
  const selected = input.gates
    .filter((gate) => gate.required && gate.status === 'fail')
    .sort((a, b) => {
      const ca = a.failureCategories[0] ?? 'zz-unknown'
      const cb = b.failureCategories[0] ?? 'zz-unknown'
      return ca < cb ? -1 : ca > cb ? 1 : a.gateKey < b.gateKey ? -1 : 1
    })
    .slice(0, input.batchLimit)
    .map((gate) => gate.gateKey)
  return receipt(
    'pipeline.repair',
    input.inputFactDigest,
    'pipeline/category-then-gate@1',
    selected,
  )
}

/** verification repair：按 (stepId, failureRef) 稳定排序。 */
export function selectVerificationWorkSet(input: {
  readonly failures: readonly { readonly stepId: string; readonly failureRef: string }[]
  readonly inputFactDigest: string
}): WorkSelectionReceipt {
  const selected = [...input.failures]
    .sort((a, b) =>
      a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : a.failureRef < b.failureRef ? -1 : 1,
    )
    .map((f) => `${f.stepId}:${f.failureRef}`)
  return receipt(
    'verification.repair',
    input.inputFactDigest,
    'verification/step-then-ref@1',
    selected,
  )
}

// ------------------------------------------------------- employee selection

export interface EmployeeSelectionRule {
  readonly ruleId: string
  readonly when: readonly FactPredicate[]
  readonly employeeRef: string
}

export interface AdmissionAssignmentInput {
  readonly scope: 'repository' | 'repository-group' | 'global-default'
  readonly employeeRef: string | null
  readonly selectionRules: readonly EmployeeSelectionRule[] | null
  readonly executionPolicyRef: string | null
  readonly defaultRequirementSourceKey: string | null
}

export type EmployeeSelectionOutcome =
  | {
      readonly outcome: 'selected'
      readonly employeeRef: string
      readonly selectionMode: 'explicit' | 'assignment' | 'rule' | 'fallback'
      readonly matchedRuleId: string | null
      readonly indeterminateFact: null
    }
  | {
      readonly outcome: 'blocked'
      readonly reason: 'no-employee-match' | 'selection-indeterminate'
      readonly indeterminateFact: string | null
    }

/** §3.8：explicit > assignment.employee > assignment.selectionRules first-match > fallback。 */
export function resolveEmployeeSelection(input: {
  readonly explicitEmployeeRef: string | null
  readonly assignment: AdmissionAssignmentInput | null
  readonly explicitFallbackRef: string | null
  readonly snapshot: MissionFactSnapshot
}): EmployeeSelectionOutcome {
  if (input.explicitEmployeeRef !== null) {
    return {
      outcome: 'selected',
      employeeRef: input.explicitEmployeeRef,
      selectionMode: 'explicit',
      matchedRuleId: null,
      indeterminateFact: null,
    }
  }
  const assignment = input.assignment
  if (assignment !== null) {
    if (assignment.employeeRef !== null) {
      return {
        outcome: 'selected',
        employeeRef: assignment.employeeRef,
        selectionMode: 'assignment',
        matchedRuleId: null,
        indeterminateFact: null,
      }
    }
    for (const rule of assignment.selectionRules ?? []) {
      let matched = true
      for (const predicate of rule.when) {
        const r = evaluatePredicate(input.snapshot, predicate)
        if (r.value === 'indeterminate') {
          return {
            outcome: 'blocked',
            reason: 'selection-indeterminate',
            indeterminateFact: r.indeterminateFact,
          }
        }
        if (r.value === false) {
          matched = false
          break
        }
      }
      if (matched) {
        return {
          outcome: 'selected',
          employeeRef: rule.employeeRef,
          selectionMode: 'rule',
          matchedRuleId: rule.ruleId,
          indeterminateFact: null,
        }
      }
    }
  }
  if (input.explicitFallbackRef !== null) {
    return {
      outcome: 'selected',
      employeeRef: input.explicitFallbackRef,
      selectionMode: 'fallback',
      matchedRuleId: null,
      indeterminateFact: null,
    }
  }
  return { outcome: 'blocked', reason: 'no-employee-match', indeterminateFact: null }
}

// ---------------------------------------------------------- template routes

export interface CapabilityRouteRule {
  readonly ruleId: string
  readonly when: readonly FactPredicate[]
  readonly templateRef: string
}

export type TemplateRouteOutcome =
  | {
      readonly outcome: 'selected'
      readonly templateRef: string
      readonly matchedRuleId: string | null
    }
  | {
      readonly outcome: 'blocked'
      readonly reason: 'no-route-match' | 'route-indeterminate'
      readonly indeterminateFact: string | null
    }

/** 员工内 capability route first-match；fallback 必须显式（design §3.6）。 */
export function selectActionTemplate(input: {
  readonly rules: readonly CapabilityRouteRule[]
  readonly fallbackTemplateRef: string | null
  readonly snapshot: MissionFactSnapshot
}): TemplateRouteOutcome {
  for (const rule of input.rules) {
    let matched = true
    for (const predicate of rule.when) {
      const r = evaluatePredicate(input.snapshot, predicate)
      if (r.value === 'indeterminate') {
        return {
          outcome: 'blocked',
          reason: 'route-indeterminate',
          indeterminateFact: r.indeterminateFact,
        }
      }
      if (r.value === false) {
        matched = false
        break
      }
    }
    if (matched) {
      return { outcome: 'selected', templateRef: rule.templateRef, matchedRuleId: rule.ruleId }
    }
  }
  if (input.fallbackTemplateRef !== null) {
    return { outcome: 'selected', templateRef: input.fallbackTemplateRef, matchedRuleId: null }
  }
  return { outcome: 'blocked', reason: 'no-route-match', indeterminateFact: null }
}
