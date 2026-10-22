import {
  canonicalJson,
  type GraphDesignDocument,
  type GraphPredicate,
  type GraphSubmodel,
} from '@agent-workflow/shared'

export function evaluateGraphPredicate(
  predicate: GraphPredicate,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const actual = values[predicate.field]
  const expected = predicate.value
  switch (predicate.operator) {
    case 'exists':
      return Object.hasOwn(values, predicate.field)
    case 'eq':
      return actual === expected
    case 'neq':
      return Object.hasOwn(values, predicate.field) && actual !== expected
    case 'in':
      return Array.isArray(expected) && expected.some((item) => item === actual)
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
  }
}

export function enumerateGraphStatePaths(
  document: GraphDesignDocument,
  model: Extract<GraphSubmodel, { kind: 'state' }>,
  bounds: {
    readonly depth: number
    readonly paths: number
    readonly inputs: readonly Readonly<Record<string, unknown>>[]
  },
): {
  readonly paths: readonly {
    readonly stateIds: readonly string[]
    readonly transitionIds: readonly string[]
    readonly input: Readonly<Record<string, unknown>>
  }[]
  readonly uncoveredTransitionIds: readonly string[]
  readonly missingBindingIds: readonly string[]
  readonly truncated: boolean
} {
  if (
    !Number.isInteger(bounds.depth) ||
    !Number.isInteger(bounds.paths) ||
    bounds.depth < 0 ||
    bounds.paths < 1
  )
    throw new Error('graph-state-invalid-bounds')
  const relations = new Map(document.relations.map((item) => [item.id, item]))
  const paths: {
    stateIds: string[]
    transitionIds: string[]
    input: Readonly<Record<string, unknown>>
  }[] = []
  const covered = new Set<string>()
  let truncated = false
  for (const input of bounds.inputs) {
    const queue = [{ stateIds: [model.initialStateId], transitionIds: [] as string[], input }]
    for (let index = 0; index < queue.length; index++) {
      if (paths.length >= bounds.paths) {
        truncated = true
        break
      }
      const path = queue[index]!
      paths.push(path)
      for (const transitionId of path.transitionIds) covered.add(transitionId)
      const next = model.transitions.filter(
        (transition) =>
          relations.get(transition.relationId)?.from === path.stateIds.at(-1) &&
          transition.guards.every((guard) => evaluateGraphPredicate(guard, input)),
      )
      if (path.transitionIds.length >= bounds.depth) {
        if (next.length) truncated = true
        continue
      }
      for (const transition of next) {
        if (queue.length >= bounds.paths) {
          truncated = true
          break
        }
        const relation = relations.get(transition.relationId)!
        queue.push({
          stateIds: [...path.stateIds, relation.to],
          transitionIds: [...path.transitionIds, transition.relationId],
          input,
        })
      }
    }
  }
  return {
    paths,
    uncoveredTransitionIds: model.transitions
      .filter((item) => !covered.has(item.relationId))
      .map((item) => item.relationId),
    missingBindingIds: model.transitions
      .filter((item) => !item.actionRef || !item.assertionRefs.length)
      .map((item) => item.relationId),
    truncated,
  }
}

export function checkGraphDecisionTable(
  model: Extract<GraphSubmodel, { kind: 'decision-table' }>,
  inputs: readonly Readonly<Record<string, unknown>>[],
): readonly {
  readonly input: Readonly<Record<string, unknown>>
  readonly matchedRuleIds: readonly string[]
  readonly result: 'matched' | 'uncovered' | 'conflict'
  readonly outputs: readonly Readonly<Record<string, unknown>>[]
}[] {
  return inputs.map((input) => {
    const matched = model.rows
      .filter((row) =>
        row.conditions.every((condition) => evaluateGraphPredicate(condition, input)),
      )
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    const chosen =
      model.resolution === 'first-priority'
        ? matched.filter((row) => row.priority === matched[0]?.priority)
        : matched
    const conflicting =
      model.resolution !== 'collect' &&
      (model.resolution === 'unique'
        ? chosen.length > 1
        : new Set(chosen.map((row) => canonicalJson(row.output))).size > 1)
    return {
      input,
      matchedRuleIds: chosen.map((row) => row.ruleId),
      result: !chosen.length ? 'uncovered' : conflicting ? 'conflict' : 'matched',
      outputs: chosen.map((row) => row.output),
    }
  })
}
