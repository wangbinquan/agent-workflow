import { z } from 'zod'
import {
  canonicalJson,
  type GraphBehaviorCheck,
  type GraphDesignDocument,
} from '@agent-workflow/shared'
import {
  enumerateGraphStatePaths,
  checkGraphDecisionTable,
} from '../../domain/graph-development/behaviorChecks'
import type { VerificationCommandEffects } from '../ports/verificationCommandEffects'

const observation = z
  .object({
    states: z.array(z.string()).optional(),
    assertions: z.record(z.boolean()),
    outputs: z.array(z.record(z.unknown())).optional(),
  })
  .strict()
/** Expected behavior is calculated here, independently of the candidate adapter's observations. */
export async function verifyGraphBehavior(input: {
  document: GraphDesignDocument
  check: GraphBehaviorCheck
  workspaceRef: string
  effects: VerificationCommandEffects
}) {
  const { check, effects } = input
  const model = input.document.models.find((model) => model.id === check.modelId)
  const limitations: string[] = [
    '结果仅覆盖列出的输入值、路径和执行环境；适配器与业务实现的接线仍需代码审核。',
  ]
  const cases: {
    id: string
    request: unknown
    expected: { states?: readonly string[]; outputs?: readonly Readonly<Record<string, unknown>>[] }
    assertions: string[]
  }[] = []
  if (!model || !['state', 'decision-table'].includes(model.kind) || !effects.invokeBehavior)
    return {
      result: 'not-run' as const,
      limitations: ['缺少支持的行为模型或执行适配器。'],
      cases: [],
    }
  if (model.kind === 'state') {
    const enumerated = enumerateGraphStatePaths(input.document, model, {
      depth: check.depth,
      paths: check.paths,
      inputs: check.inputs,
    })
    if (enumerated.truncated) limitations.push('探索达到深度或路径上限。')
    if (enumerated.uncoveredTransitionIds.length)
      limitations.push(`未覆盖迁移：${enumerated.uncoveredTransitionIds.join(', ')}`)
    if (enumerated.missingBindingIds.length)
      limitations.push(`缺少动作或断言绑定：${enumerated.missingBindingIds.join(', ')}`)
    for (const [index, path] of enumerated.paths.entries()) {
      const actions = path.transitionIds.map(
        (id) => model.transitions.find((transition) => transition.relationId === id)!,
      )
      if (
        !actions.length ||
        actions.some((action) => !action.actionRef || !action.assertionRefs.length)
      )
        continue
      cases.push({
        id: `${model.id}:${index}`,
        request: {
          schemaVersion: 1,
          modelId: model.id,
          kind: 'state',
          input: path.input,
          actions: actions.map((action) => ({
            event: action.event,
            actionRef: action.actionRef,
            assertionRefs: action.assertionRefs,
          })),
        },
        expected: { states: path.stateIds },
        assertions: actions.flatMap((action) => action.assertionRefs),
      })
    }
  } else if (model.kind === 'decision-table') {
    const decisions = checkGraphDecisionTable(model, check.inputs)
    for (const [index, decision] of decisions.entries()) {
      if (decision.result !== 'matched') {
        limitations.push(`${decision.result}: ${canonicalJson(decision.input)}`)
        continue
      }
      const assertions = model.rows
        .filter((row) => decision.matchedRuleIds.includes(row.ruleId))
        .flatMap((row) => row.assertionRefs)
      if (!assertions.length) {
        limitations.push(`缺少规则断言：${decision.matchedRuleIds.join(', ')}`)
        continue
      }
      cases.push({
        id: `${model.id}:${index}`,
        request: {
          schemaVersion: 1,
          modelId: model.id,
          kind: 'decision-table',
          input: decision.input,
          assertionRefs: assertions,
        },
        expected: { outputs: decision.outputs },
        assertions,
      })
    }
  }
  const receipts = [],
    deadline = Date.now() + check.timeoutMs
  let failed = false
  for (const entry of cases) {
    const remaining = deadline - Date.now()
    if (remaining < 1) {
      limitations.push('行为检查达到时间上限。')
      break
    }
    const run = await effects.invokeBehavior({
      workspaceRef: input.workspaceRef,
      programRef: check.programRef,
      inputJson: canonicalJson(entry.request),
      timeoutMs: remaining,
    })
    let actual: z.infer<typeof observation> | null = null
    try {
      actual = observation.parse(JSON.parse(run.outputJson))
    } catch {
      /* Invalid output remains failed evidence. */
    }
    const passed =
      run.exitCode === 0 &&
      !run.timedOut &&
      actual !== null &&
      entry.assertions.every((ref) => actual!.assertions[ref] === true) &&
      (!entry.expected.states ||
        canonicalJson(actual.states ?? null) === canonicalJson(entry.expected.states)) &&
      (!entry.expected.outputs ||
        canonicalJson(actual.outputs ?? null) === canonicalJson(entry.expected.outputs))
    if (!passed) failed = true
    receipts.push({ ...entry, actual, run, passed })
  }
  return {
    result: failed
      ? ('failed' as const)
      : limitations.length > 1 || receipts.length !== cases.length || !cases.length
        ? ('inconclusive' as const)
        : ('passed' as const),
    limitations,
    cases: receipts,
  }
}
