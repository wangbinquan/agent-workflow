import type {
  GraphContentRef,
  GraphDesignActionRequest,
  GraphDesignDocument,
} from '@agent-workflow/shared'
import { graphContentRefs, graphDependencyRefId, graphDigest, graphModelMembers } from './model'

const collections = [
  'concerns',
  'elements',
  'relations',
  'models',
  'views',
  'sources',
  'obligations',
] as const
const relatedKinds = new Set(['depends-on', 'implements', 'verifies', 'containment'])
export interface GraphPlanningScope {
  readonly local: boolean
  readonly document: GraphDesignDocument
  readonly readSet: GraphContentRef[]
  readonly objectIds: ReadonlySet<string>
}

export function graphSemanticClosureIds(
  document: GraphDesignDocument,
  seedIds: readonly string[],
): Set<string> {
  const included = new Set(seedIds)
  const include = (...ids: string[]) => ids.forEach((id) => included.add(id))
  let count = -1
  while (count !== included.size) {
    count = included.size
    for (const view of document.views)
      if (included.has(view.id))
        include(
          ...view.elementIds,
          ...view.relationIds,
          ...view.modelIds,
          ...view.concernIds,
          ...view.sourceIds,
        )
    for (const relation of document.relations)
      if (
        included.has(relation.id) ||
        (included.has(relation.from) &&
          (included.has(relation.to) || relatedKinds.has(relation.kind)))
      )
        include(relation.id, relation.from, relation.to, ...relation.sourceIds)
    for (const model of document.models)
      if (included.has(model.id) || graphModelMembers(model).some((id) => included.has(id)))
        include(model.id, ...graphModelMembers(model), ...model.sourceIds)
    for (const element of document.elements)
      if (included.has(element.id))
        include(
          ...element.sourceIds,
          ...(element.kind === 'requirement' ? element.obligationIds : []),
        )
    for (const obligation of document.obligations)
      if (included.has(obligation.id) || obligation.elementIds.some((id) => included.has(id)))
        include(
          obligation.id,
          ...obligation.elementIds,
          ...obligation.concernIds,
          ...(obligation.verification.kind === 'execution' && obligation.verification.modelCheck
            ? [obligation.verification.modelCheck.modelId]
            : []),
        )
    for (const concern of document.concerns)
      if (included.has(concern.id) || concern.resolutionIds.some((id) => included.has(id)))
        include(concern.id, ...concern.resolutionIds, ...concern.sourceIds)
  }
  return included
}

/** A local call gets a closed semantic subset, not a full document with a misleading small read set. */
export function graphPlanningScope(
  document: GraphDesignDocument,
  request: GraphDesignActionRequest,
): GraphPlanningScope {
  const anchor = request.anchor
  if (
    request.action === 'replan' ||
    !anchor ||
    !(anchor.elementIds.length || anchor.relationIds.length || anchor.viewId)
  )
    return {
      local: false,
      document,
      readSet: graphContentRefs(document),
      objectIds: new Set(graphContentRefs(document).map((ref) => ref.id)),
    }
  const selectedIds = [...anchor.elementIds, ...anchor.relationIds]
  // For a selected element/path the view is only a locator. Reading all of its
  // projections would unnecessarily bind the request to unrelated branches.
  const seedIds =
    request.action === 'update-view' && anchor.viewId
      ? [anchor.viewId]
      : selectedIds.length
        ? selectedIds
        : anchor.viewId
          ? [anchor.viewId]
          : []
  const included = graphSemanticClosureIds(document, seedIds)
  // Include other readings only when every referenced semantic object is already
  // in scope. A broad overview must not pull an independent branch into a local call.
  for (const view of document.views) {
    const references = [
      ...view.modelIds,
      ...view.elementIds,
      ...view.relationIds,
      ...view.concernIds,
      ...view.sourceIds,
    ]
    if (
      view.status !== 'archived' &&
      references.length &&
      references.every((id) => included.has(id))
    )
      included.add(view.id)
  }
  const material = { ...document }
  for (const key of collections)
    Object.assign(material, { [key]: document[key].filter((item) => included.has(item.id)) })
  const readIds = new Set(included)
  readIds.add(`${document.id}:scope`)
  readIds.add(`${document.id}:repository`)
  for (const element of material.elements) readIds.add(graphDependencyRefId(element.id))
  return {
    local: true,
    document: material,
    readSet: graphContentRefs(document).filter((ref) => readIds.has(ref.id)),
    objectIds: included,
  }
}

/** Local proposals contain only the closed material read by the call. Existing
 * applyGraphProposal preserves unread current objects without weakening its
 * undeclared-write check for a model attempting to name an unseen identity. */
export function mergeGraphPlanningDocument(
  original: GraphDesignDocument,
  scope: GraphPlanningScope,
  proposed: GraphDesignDocument,
): GraphDesignDocument {
  if (!scope.local) return proposed
  if (
    graphDigest([original.title, original.goals]) !== graphDigest([proposed.title, proposed.goals])
  )
    throw new Error('graph-local-global-scope-change')
  const existingIds = new Set(collections.flatMap((key) => original[key].map((item) => item.id)))
  for (const key of collections) {
    for (const item of proposed[key])
      if (existingIds.has(item.id) && !scope.objectIds.has(item.id))
        throw new Error(`graph-local-undeclared-object:${item.id}`)
  }
  return proposed
}
