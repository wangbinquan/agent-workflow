import type { GraphDesignDocument, GraphViewPlan, GraphViewProposal } from '@agent-workflow/shared'
import { graphContentRefs } from './model'
import { graphViewCapability } from './viewCapabilities'

export interface GraphPlanningBudget {
  readonly reading: number
  readonly generation: number
}
export const GRAPH_DEFAULT_PLANNING_BUDGET: GraphPlanningBudget = Object.freeze({
  reading: 12,
  generation: 24,
})
const concernWeight = { required: 8, important: 3, optional: 1 } as const

/** Deterministic bounded recommendation given candidates; candidate generation remains model-driven. */
export function selectGraphViews(
  document: GraphDesignDocument,
  candidates: readonly GraphViewProposal[],
  budget: GraphPlanningBudget,
): GraphViewPlan {
  if (
    !Number.isFinite(budget.reading) ||
    !Number.isFinite(budget.generation) ||
    budget.reading < 0 ||
    budget.generation < 0
  )
    throw new Error('graph-planning-invalid-budget')
  const concerns = new Map(
    document.concerns
      .filter((item) => item.disposition !== 'out-of-scope')
      .map((item) => [item.id, item]),
  )
  const objects = new Map(graphContentRefs(document).map((ref) => [ref.id, ref]))
  const modelKinds = new Map(document.models.map((model) => [model.id, model.kind]))
  const decisions: GraphViewPlan['decisions'] = []
  const counts = new Map<string, number>()
  for (const candidate of candidates) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1)
  const valid: GraphViewProposal[] = []
  for (const candidate of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const capability = graphViewCapability(
      candidate.capabilityRef.id,
      candidate.capabilityRef.version,
    )
    let reason: string | null = null
    if (counts.get(candidate.id)! > 1) reason = 'duplicate-candidate'
    else if (!capability) reason = 'unsupported-capability-version'
    else if (
      ![
        ...candidate.modelIds,
        ...candidate.elementIds,
        ...candidate.relationIds,
        ...candidate.sourceIds,
      ].every((id) => objects.has(id))
    )
      reason = 'unresolved-reference'
    else if (candidate.modelIds.some((id) => !capability.modelKinds.includes(modelKinds.get(id)!)))
      reason = 'incompatible-expression'
    else if (!candidate.coverage.every((item) => concerns.has(item.concernId)))
      reason = 'unknown-or-excluded-concern'
    if (reason)
      decisions.push({ candidateId: candidate.id, selected: false, reason, marginalValue: 0 })
    else valid.push(candidate)
  }
  const pinned = document.views.filter((view) => view.pinned && view.status !== 'archived')
  const selected = new Map<string, GraphViewProposal>()
  for (const view of pinned) {
    const candidate =
      view.status === 'current' ? valid.find((item) => item.id === view.id) : undefined
    selected.set(
      view.id,
      candidate ?? {
        id: view.id,
        title: view.title,
        purpose: view.purpose,
        capabilityRef: view.capabilityRef,
        coverage: view.concernIds
          .filter((id) => concerns.has(id))
          .map((concernId) => ({
            concernId,
            contribution: view.status === 'current' ? 1 : 0,
            explanation: '用户固定的现有视图',
          })),
        modelIds: view.modelIds,
        elementIds: view.elementIds,
        relationIds: view.relationIds,
        sourceIds: view.sourceIds,
        readingCost: 1,
        generationCost: 0,
        rationale: '用户固定；过期时保留并提示更新。',
        limitations: view.limitations,
        replaces: [],
      },
    )
  }
  function coverage(items: Iterable<GraphViewProposal>): Map<string, number> {
    const result = new Map<string, number>()
    for (const candidate of items) {
      const best = new Map<string, number>()
      for (const item of candidate.coverage)
        best.set(item.concernId, Math.max(best.get(item.concernId) ?? 0, item.contribution))
      for (const [id, value] of best) result.set(id, Math.min(1, (result.get(id) ?? 0) + value))
    }
    return result
  }
  function value(items: Iterable<GraphViewProposal>): number {
    return [...coverage(items)].reduce(
      (total, [id, contribution]) =>
        total + concernWeight[concerns.get(id)!.priority] * contribution,
      0,
    )
  }
  function cost(items: Iterable<GraphViewProposal>): GraphPlanningBudget {
    return [...items].reduce(
      (total, item) => ({
        reading: total.reading + item.readingCost,
        generation: total.generation + item.generationCost,
      }),
      { reading: 0, generation: 0 },
    )
  }
  while (true) {
    const used = cost(selected.values())
    const currentValue = value(selected.values())
    const ranked = valid
      .filter((item) => !selected.has(item.id))
      .map((candidate) => {
        const gain = value([...selected.values(), candidate]) - currentValue
        const score =
          gain / (candidate.readingCost + candidate.generationCost * 0.25) -
          candidate.readingCost * 0.02
        return { candidate, gain, score }
      })
      .filter(
        ({ candidate, gain }) =>
          gain > 0 &&
          used.reading + candidate.readingCost <= budget.reading &&
          used.generation + candidate.generationCost <= budget.generation,
      )
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    const best = ranked[0]
    if (!best || best.score <= 0) break
    selected.set(best.candidate.id, best.candidate)
  }
  // One bounded replacement pass can escape a greedy choice that consumed the budget.
  for (const candidate of valid.filter((item) => !selected.has(item.id))) {
    const alternatives = [...selected.values()]
      .filter((item) => !pinned.some((view) => view.id === item.id))
      .map((removed) => ({
        removed,
        next: [...selected.values()].filter((item) => item.id !== removed.id).concat(candidate),
      }))
      .filter(({ next }) => {
        const used = cost(next)
        return (
          used.reading <= budget.reading &&
          used.generation <= budget.generation &&
          value(next) > value(selected.values())
        )
      })
      .sort((a, b) => value(b.next) - value(a.next) || a.removed.id.localeCompare(b.removed.id))
    const replacement = alternatives[0]
    if (replacement) {
      selected.delete(replacement.removed.id)
      selected.set(candidate.id, candidate)
    }
  }
  // Remove redundant choices only if all attained concern coverage is retained.
  for (const candidate of [...selected.values()].sort(
    (a, b) => b.readingCost - a.readingCost || a.id.localeCompare(b.id),
  )) {
    if (pinned.some((view) => view.id === candidate.id)) continue
    const remaining = [...selected.values()].filter((item) => item.id !== candidate.id)
    if (value(remaining) >= value(selected.values())) selected.delete(candidate.id)
  }
  const attained = coverage(selected.values())
  for (const candidate of valid) {
    const included = selected.has(candidate.id)
    const others = [...selected.values()].filter((item) => item.id !== candidate.id)
    decisions.push({
      candidateId: candidate.id,
      selected: included,
      reason: pinned.some((view) => view.id === candidate.id)
        ? 'user-pinned'
        : included
          ? 'additional-concern-coverage'
          : 'redundant-or-over-budget',
      marginalValue: value([...others, candidate]) - value(others),
    })
  }
  for (const view of pinned.filter((view) => !valid.some((candidate) => candidate.id === view.id)))
    decisions.push({
      candidateId: view.id,
      selected: true,
      reason: 'user-pinned',
      marginalValue: 0,
    })
  const used = cost(selected.values())
  return {
    policyVersion: 1,
    catalogVersion: 1,
    readSet: graphContentRefs(document),
    selectedIds: [...selected.keys()],
    uncoveredConcernIds: [...concerns.keys()].filter((id) => (attained.get(id) ?? 0) < 1),
    overBudget: used.reading > budget.reading || used.generation > budget.generation,
    candidates: [
      ...new Map([...valid, ...selected.values()].map((item) => [item.id, item])).values(),
    ],
    decisions,
  }
}
