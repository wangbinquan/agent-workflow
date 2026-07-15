// RFC-192 (T1) — the /tasks list's client-side filter (决策 D2: pure
// frontend; the API keeps owning the status dimension via its query param).
//
// Subject classification MUST go through the shared `taskExecutionKind`
// (RFC-165 single derivation point — flag-audit "kind scatter" lesson;
// workgroup wins over agent by that oracle's ordering, never re-derived here).

import type { TaskSummary } from '@agent-workflow/shared'
import { taskExecutionKind } from '@agent-workflow/shared'

export type TaskSubjectFilter = 'all' | 'workflow' | 'workgroup' | 'agent'

export interface TaskListFilter {
  subject: TaskSubjectFilter
  /** Case-insensitive substring over the task display name. */
  search: string
}

export function filterTaskRows(rows: TaskSummary[], f: TaskListFilter): TaskSummary[] {
  const q = f.search.trim().toLowerCase()
  if (f.subject === 'all' && q === '') return rows
  return rows.filter((row) => {
    if (f.subject !== 'all' && taskExecutionKind(row) !== f.subject) return false
    if (q !== '' && !row.name.toLowerCase().includes(q)) return false
    return true
  })
}
