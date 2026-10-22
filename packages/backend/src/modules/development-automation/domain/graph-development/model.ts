import {
  canonicalJson,
  clarifyDecisionsEqual,
  GraphDesignDocumentSchema,
  type GraphContentRef,
  type GraphDesignDocument,
  type GraphProposal,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'

export interface GraphIssue {
  readonly code: string
  readonly subjectId: string
  readonly detail: string
}

export function graphDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/** Read sets contain semantic objects only; viewport changes cannot stale a decision. */
export function graphContentRefs(document: GraphDesignDocument): GraphContentRef[] {
  const objects = [
    ...document.concerns,
    ...document.elements,
    ...document.relations,
    ...document.models,
    ...document.views,
    ...document.obligations,
    ...document.sources.map((source) => ({ ...source, revision: 1 })),
    ...document.elements.map((element) => ({
      id: graphDependencyRefId(element.id),
      revision: 1,
      relations: document.relations
        .filter((relation) => relation.from === element.id || relation.to === element.id)
        .map((relation) => relation.id)
        .sort(),
      models: document.models
        .filter((model) => graphModelMembers(model).includes(element.id))
        .map((model) => model.id)
        .sort(),
      obligations: document.obligations
        .filter((obligation) => obligation.elementIds.includes(element.id))
        .map((obligation) => obligation.id)
        .sort(),
      concerns: document.concerns
        .filter((concern) => concern.resolutionIds.includes(element.id))
        .map((concern) => concern.id)
        .sort(),
    })),
    {
      id: `${document.id}:repository`,
      revision: 1,
      repositoryId: document.repositoryId,
      baseline: document.repositoryBaseline,
    },
    { id: `${document.id}:scope`, revision: 1, title: document.title, goals: document.goals },
  ]
  return objects
    .map((value) => ({ id: value.id, revision: value.revision, digest: graphDigest(value) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function graphDependencyRefId(id: string) {
  return `dependencies:${graphDigest(id).slice(0, 40)}`
}

export function staleGraphReads(
  document: GraphDesignDocument,
  readSet: readonly GraphContentRef[],
): string[] {
  const current = new Map(graphContentRefs(document).map((ref) => [ref.id, ref]))
  return readSet
    .filter((ref) => {
      const actual = current.get(ref.id)
      return !actual || actual.revision !== ref.revision || actual.digest !== ref.digest
    })
    .map((ref) => ref.id)
}

/** Close the selected implementation scope over actual semantic dependencies, not layout. */
export function graphScopeContentRefs(
  document: GraphDesignDocument,
  elementIds: readonly string[],
): GraphContentRef[] {
  const included = new Set(elementIds)
  const take = (id: string) => {
    const changed = !included.has(id)
    included.add(id)
    return changed
  }
  let changed = true
  while (changed) {
    changed = false
    for (const relation of document.relations) {
      if (
        included.has(relation.from) &&
        ['depends-on', 'implements', 'verifies', 'containment'].includes(relation.kind)
      ) {
        changed = take(relation.id) || changed
        changed = take(relation.to) || changed
      }
      if (included.has(relation.from) && included.has(relation.to))
        changed = take(relation.id) || changed
    }
    for (const model of document.models)
      if (graphModelMembers(model).some((id) => included.has(id))) {
        changed = take(model.id) || changed
        for (const id of graphModelMembers(model)) changed = take(id) || changed
      }
    for (const obligation of document.obligations)
      if (obligation.elementIds.some((id) => included.has(id))) {
        changed = take(obligation.id) || changed
        for (const id of [...obligation.elementIds, ...obligation.concernIds])
          changed = take(id) || changed
      }
    for (const concern of document.concerns)
      if (concern.resolutionIds.some((id) => included.has(id)))
        changed = take(concern.id) || changed
    for (const item of [
      ...document.elements,
      ...document.relations,
      ...document.models,
      ...document.concerns,
    ])
      if (included.has(item.id)) for (const id of item.sourceIds) changed = take(id) || changed
  }
  included.add(`${document.id}:repository`)
  included.add(`${document.id}:scope`)
  for (const element of document.elements)
    if (included.has(element.id)) included.add(graphDependencyRefId(element.id))
  return graphContentRefs(document).filter((ref) => included.has(ref.id))
}

export function validateGraphDocument(input: unknown): GraphIssue[] {
  const decoded = GraphDesignDocumentSchema.safeParse(input)
  if (!decoded.success)
    return decoded.error.issues.map((issue) => ({
      code: 'schema',
      subjectId: issue.path.join('.'),
      detail: issue.message,
    }))
  const document = decoded.data
  const issues: GraphIssue[] = []
  const report = (code: string, subjectId: string, detail: string): void => {
    issues.push({ code, subjectId, detail })
  }
  const all = new Map<string, unknown>()
  for (const item of [
    ...document.concerns,
    ...document.elements,
    ...document.relations,
    ...document.models,
    ...document.views,
    ...document.sources,
    ...document.obligations,
  ]) {
    if (all.has(item.id))
      report('duplicate-id', item.id, 'Semantic identities must be unique, independent of labels.')
    all.set(item.id, item)
  }
  const elements = new Map(document.elements.map((item) => [item.id, item]))
  const relations = new Map(document.relations.map((item) => [item.id, item]))
  const sources = new Map(document.sources.map((item) => [item.id, item]))
  const concerns = new Set(document.concerns.map((item) => item.id))
  const models = new Map(document.models.map((item) => [item.id, item]))
  const obligations = new Set(document.obligations.map((item) => item.id))
  function references(
    owner: string,
    values: readonly string[],
    exists: (value: string) => boolean,
  ): void {
    for (const value of values) if (!exists(value)) report('missing-reference', owner, value)
  }
  for (const item of [
    ...document.concerns,
    ...document.elements,
    ...document.relations,
    ...document.models,
    ...document.views,
  ]) {
    references(item.id, item.sourceIds, (value) => sources.has(value))
  }
  for (const concern of document.concerns) {
    references(concern.id, concern.resolutionIds, (value) => all.has(value))
    if (
      ['deferred', 'out-of-scope'].includes(concern.disposition) &&
      !concern.dispositionReason?.trim()
    )
      report('missing-disposition-reason', concern.id, 'Scope changes require a visible reason.')
  }
  for (const item of document.elements) {
    if (item.kind === 'requirement')
      references(item.id, item.obligationIds, (value) => obligations.has(value))
    if (item.kind === 'decision') {
      const humanSources = item.sourceIds
        .map((sourceId) => sources.get(sourceId))
        .filter((source) => source?.kind === 'clarify')
      if (
        item.decision &&
        !humanSources.some((source) => clarifyDecisionsEqual(source?.decision, item.decision))
      )
        report(
          'decision-source-mismatch',
          item.id,
          'User-marked maturity and notes must match a committed answer source.',
        )
    }
  }
  const contains = new Map<string, string[]>()
  for (const relation of document.relations) {
    references(relation.id, [relation.from, relation.to], (value) => all.has(value))
    if (relation.kind === 'containment')
      contains.set(relation.from, [...(contains.get(relation.from) ?? []), relation.to])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(current: string): void {
    if (visiting.has(current)) {
      report(
        'containment-cycle',
        current,
        'Containment cannot contain a cycle. Behavioral cycles are allowed.',
      )
      return
    }
    if (visited.has(current)) return
    visiting.add(current)
    for (const child of contains.get(current) ?? []) visit(child)
    visiting.delete(current)
    visited.add(current)
  }
  for (const current of contains.keys()) visit(current)
  for (const model of document.models) {
    const checkElements = (values: readonly string[]): void =>
      references(model.id, values, (value) => elements.has(value))
    const checkRelations = (values: readonly string[]): void =>
      references(model.id, values, (value) => relations.has(value))
    switch (model.kind) {
      case 'flow':
        checkElements(model.elementIds)
        checkRelations(model.relationIds)
        break
      case 'sequence':
        checkElements(model.participantIds)
        checkRelations(model.messageIds)
        {
          const assigned = new Set<string>()
          for (const fragment of model.fragments) {
            references(model.id, fragment.messageIds, (value) => model.messageIds.includes(value))
            const indexes = fragment.messageIds.map((id) => model.messageIds.indexOf(id))
            if (
              !indexes.length ||
              indexes.some((index, i) => i > 0 && index !== indexes[i - 1]! + 1)
            )
              report(
                'non-contiguous-sequence-fragment',
                fragment.id,
                'A fragment must preserve a contiguous message range in authored order.',
              )
            for (const id of fragment.messageIds) {
              if (assigned.has(id)) report('overlapping-sequence-fragments', fragment.id, id)
              assigned.add(id)
            }
          }
        }
        for (const messageId of model.messageIds) {
          const message = relations.get(messageId)
          if (
            message &&
            (!model.participantIds.includes(message.from) ||
              !model.participantIds.includes(message.to))
          )
            report('message-outside-participants', model.id, messageId)
        }
        break
      case 'state':
        checkElements(model.stateIds)
        references(model.id, [model.initialStateId, ...model.terminalStateIds], (value) =>
          model.stateIds.includes(value),
        )
        for (const transition of model.transitions) {
          checkRelations([transition.relationId])
          const relation = relations.get(transition.relationId)
          if (
            relation &&
            (!model.stateIds.includes(relation.from) || !model.stateIds.includes(relation.to))
          )
            report('transition-outside-states', model.id, transition.relationId)
        }
        break
      case 'data':
        checkElements(model.entityIds)
        checkRelations(model.relationships.map((item) => item.relationId))
        for (const entityId of model.entityIds)
          if (elements.get(entityId)?.kind !== 'entity')
            report('expected-entity', model.id, entityId)
        break
      case 'decision-table':
        for (const row of model.rows) {
          checkElements([row.ruleId])
          references(
            row.id,
            row.conditions.map((condition) => condition.field),
            (value) => model.inputFields.includes(value),
          )
          for (const condition of row.conditions)
            if (condition.operator !== 'exists' && condition.value === undefined)
              report('predicate-value-required', row.id, condition.field)
        }
        break
    }
  }
  for (const view of document.views) {
    references(view.id, view.modelIds, (value) => models.has(value))
    references(view.id, view.elementIds, (value) => elements.has(value))
    references(view.id, view.relationIds, (value) => relations.has(value))
    references(view.id, view.concernIds, (value) => concerns.has(value))
    if (view.pinned && view.status === 'archived')
      report('pinned-view-archived', view.id, 'Unpin a view explicitly before archiving it.')
  }
  for (const obligation of document.obligations) {
    references(obligation.id, obligation.elementIds, (value) => elements.has(value))
    references(obligation.id, obligation.concernIds, (value) => concerns.has(value))
    if (obligation.verification.kind === 'execution' && obligation.verification.modelCheck) {
      const check = obligation.verification.modelCheck,
        model = models.get(check.modelId)
      if (!model || !['state', 'decision-table'].includes(model.kind))
        report('unsupported-behavior-check-model', obligation.id, check.modelId)
    }
  }
  return issues
}

export function graphImpact(
  document: GraphDesignDocument,
  changedIds: readonly string[],
): {
  affectedIds: string[]
  viewIds: string[]
  obligationIds: string[]
} {
  const affected = new Set(changedIds)
  const queue = [...changedIds]
  const dependents = new Map<string, Set<string>>()
  const depends = (owner: string, dependencies: readonly string[]) => {
    for (const dependency of dependencies) {
      const values = dependents.get(dependency) ?? new Set<string>()
      values.add(owner)
      dependents.set(dependency, values)
    }
  }
  for (const item of [
    ...document.elements,
    ...document.concerns,
    ...document.relations,
    ...document.models,
    ...document.views,
  ])
    depends(item.id, item.sourceIds)
  for (const relation of document.relations) {
    if (relation.kind === 'depends-on') depends(relation.from, [relation.to])
    // A displayed edge changes when either endpoint changes; containment does not
    // make its child depend on every change elsewhere in the parent container.
    depends(relation.id, [relation.from, relation.to])
  }
  for (const model of document.models) depends(model.id, graphModelMembers(model))
  for (const view of document.views)
    depends(view.id, [
      ...view.modelIds,
      ...view.elementIds,
      ...view.relationIds,
      ...view.concernIds,
    ])
  for (const obligation of document.obligations)
    depends(obligation.id, [...obligation.elementIds, ...obligation.concernIds])
  for (let index = 0; index < queue.length; index++) {
    for (const dependent of dependents.get(queue[index]!) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent)
        queue.push(dependent)
      }
    }
  }
  return {
    affectedIds: [...affected].sort(),
    viewIds: document.views.filter((view) => affected.has(view.id)).map((view) => view.id),
    obligationIds: document.obligations
      .filter(
        (obligation) =>
          affected.has(obligation.id) ||
          [...obligation.elementIds, ...obligation.concernIds].some((id) => affected.has(id)),
      )
      .map((obligation) => obligation.id),
  }
}

export function graphModelMembers(model: GraphDesignDocument['models'][number]): string[] {
  switch (model.kind) {
    case 'flow':
      return [...model.elementIds, ...model.relationIds]
    case 'sequence':
      return [...model.participantIds, ...model.messageIds]
    case 'state':
      return [...model.stateIds, ...model.transitions.map((t) => t.relationId)]
    case 'data':
      return [...model.entityIds, ...model.relationships.map((r) => r.relationId)]
    case 'decision-table':
      return model.rows.map((row) => row.ruleId)
  }
}

/** A view explicitly regenerated in this change remains current; untouched projections are stale. */
export function invalidateGraphViews(
  previous: GraphDesignDocument,
  next: GraphDesignDocument,
): void {
  next.views = next.views.map((view) => ({ ...view }))
  const before = new Map(graphContentRefs(previous).map((ref) => [ref.id, ref.digest]))
  const after = graphContentRefs(next)
  const afterIds = new Set(after.map((ref) => ref.id))
  const changed = after.filter((ref) => before.get(ref.id) !== ref.digest).map((ref) => ref.id)
  changed.push(...[...before.keys()].filter((id) => !afterIds.has(id)))
  const affected = new Set([
    ...graphImpact(previous, changed).viewIds,
    ...graphImpact(next, changed).viewIds,
  ])
  for (const view of next.views) {
    const old = previous.views.find((candidate) => candidate.id === view.id)
    if (
      old &&
      graphDigest(view) === graphDigest(old) &&
      affected.has(view.id) &&
      view.status === 'current'
    ) {
      view.status = 'needs-update'
      view.revision++
    }
  }
}

/** Merge only declared reads/new objects, preserving unrelated concurrent semantic edits. */
export function applyGraphProposal(
  document: GraphDesignDocument,
  proposal: GraphProposal,
):
  | { readonly status: 'stale'; readonly changedIds: string[] }
  | { readonly status: 'accepted'; readonly document: GraphDesignDocument } {
  if (
    document.id !== proposal.designId ||
    document.id !== proposal.document.id ||
    document.caseId !== proposal.document.caseId
  )
    throw new Error('graph-proposal-identity-mismatch')
  const changedIds = staleGraphReads(document, proposal.readSet)
  if (changedIds.length) return { status: 'stale', changedIds }
  const readIds = new Set(proposal.readSet.map((ref) => ref.id))
  function merge<T extends { id: string; revision?: number }>(
    current: T[],
    proposed: T[],
    immutable = false,
  ): T[] {
    const proposedIds = new Set(proposed.map((item) => item.id))
    const byId = new Map(
      current
        .filter((item) => immutable || !readIds.has(item.id) || proposedIds.has(item.id))
        .map((item) => [item.id, item]),
    )
    for (const item of proposed) {
      const previous = byId.get(item.id)
      if (previous && graphDigest(previous) === graphDigest(item)) continue
      if (previous && !readIds.has(item.id))
        throw new Error(`graph-proposal-undeclared-write:${item.id}`)
      byId.set(
        item.id,
        previous?.revision === undefined ? item : { ...item, revision: previous.revision + 1 },
      )
    }
    return [...byId.values()]
  }
  for (const source of proposal.document.sources) {
    const previous = document.sources.find((item) => item.id === source.id)
    if (previous && graphDigest(previous) !== graphDigest(source))
      throw new Error(`graph-source-is-immutable:${source.id}`)
  }
  for (const current of document.views.filter((view) => view.pinned)) {
    const next = proposal.document.views.find((view) => view.id === current.id)
    if (
      (!next && readIds.has(current.id)) ||
      (next && (!next.pinned || next.status === 'archived'))
    )
      throw new Error(`graph-proposal-cannot-unpin:${current.id}`)
  }
  const proposed = proposal.document
  const scopeChanged =
    graphDigest([document.title, document.goals]) !== graphDigest([proposed.title, proposed.goals])
  if (scopeChanged && !readIds.has(`${document.id}:scope`))
    throw new Error('graph-proposal-undeclared-scope-change')
  const next: GraphDesignDocument = {
    ...document,
    revision: document.revision + 1,
    ...(scopeChanged ? { title: proposed.title, goals: proposed.goals } : {}),
    concerns: merge(document.concerns, proposed.concerns),
    elements: merge(document.elements, proposed.elements),
    relations: merge(document.relations, proposed.relations),
    models: merge(document.models, proposed.models),
    views: merge(document.views, proposed.views),
    sources: merge(document.sources, proposed.sources, true),
    obligations: merge(document.obligations, proposed.obligations),
  }
  invalidateGraphViews(document, next)
  const issues = validateGraphDocument(next)
  if (issues.length) throw new Error(`graph-proposal-invalid:${canonicalJson(issues)}`)
  return { status: 'accepted', document: next }
}
