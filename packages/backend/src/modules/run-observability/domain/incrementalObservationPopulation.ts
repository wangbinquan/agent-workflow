import type { ObservationOverviewQuery, ObservationTaskFacts } from '@agent-workflow/shared'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'

/** Statistical membership belongs to the requested immutable version. Current
 * ownership is checked separately; a rename or status change cannot move a row
 * into or out of an already retained report. Descendants of a selected original
 * Task stay in its population even when their creation date is outside it. */
export function incrementalObservationPopulation(
  rows: readonly QualifiedObservationContribution[],
  query: ObservationOverviewQuery,
  taskId?: string,
) {
  const originals = new Map<string, QualifiedObservationContribution>()
  const children = new Map<string, string[]>()
  const ids = new Set<string>()
  const needle = query.q?.toLocaleLowerCase()
  for (const row of rows) {
    const task = (row.detail.document as { readonly task: ObservationTaskFacts }).task
    if (originals.has(task.id))
      throw new Error('Projection contains duplicate original Task metadata')
    originals.set(task.id, row)
    if (task.parentTaskId) {
      const list = children.get(task.parentTaskId) ?? []
      list.push(task.id)
      children.set(task.parentTaskId, list)
    }
    if (
      taskId !== undefined
        ? task.id === taskId
        : (query.cohort === 'usage' ||
            (task.startedAt >= query.from && task.startedAt < query.to)) &&
          (query.status === undefined || task.status === query.status) &&
          (needle === undefined ||
            task.name.toLocaleLowerCase().includes(needle) ||
            task.id.toLocaleLowerCase().includes(needle)) &&
          (query.workflow === undefined || row.detail.selectors?.workflowId === query.workflow) &&
          (query.repository === undefined ||
            row.detail.selectors?.repositories.includes(query.repository))
    )
      ids.add(task.id)
  }
  const pending = [...ids]
  for (let at = 0; at < pending.length; at++)
    for (const child of children.get(pending[at]!) ?? [])
      if (!ids.has(child)) {
        ids.add(child)
        pending.push(child)
      }
  return { ids, originals }
}
