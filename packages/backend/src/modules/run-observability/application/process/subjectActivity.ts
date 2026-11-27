// RFC-616 §9.1 — which subjects had units lately, for the weekly analysis schedule.

import { PROCESS_LIST_UNIT_LIMIT, type ProcessSubjectKind } from '@agent-workflow/shared'
import type { ProcessViewer } from '@/platform/contracts/processFacts'
import type { InsightSubjectActivity } from './insightAnalyses'
import { workflowNamesOf, type ProcessSources } from './sources'

// The schedule analyses on behalf of everyone who may read every task.
const EVERYONE: ProcessViewer = { userId: '', canReadAll: true }

export function createSubjectActivity(sources: ProcessSources) {
  return async (
    kind: ProcessSubjectKind,
    window: { readonly from: number; readonly to: number },
  ): Promise<InsightSubjectActivity[]> => {
    const newest = new Map<string, InsightSubjectActivity>()
    const note = (subjectId: string | null, name: string | null, at: number) => {
      const key = subjectId ?? ''
      const known = newest.get(key)
      if (known === undefined || at > known.newestUnitAt)
        newest.set(key, { subjectId, name: name ?? known?.name ?? null, newestUnitAt: at })
    }
    if (kind === 'digital-employee') {
      const cases = await sources.employees.cases(EVERYONE, {
        ...window,
        limit: PROCESS_LIST_UNIT_LIMIT,
      })
      for (const row of cases) note(row.employeeId, row.employeeName, row.createdAt)
      return [...newest.values()]
    }
    const rows = await sources.tasks.units(EVERYONE, {
      kind,
      ...window,
      limit: PROCESS_LIST_UNIT_LIMIT,
    })
    for (const row of rows) note(row.subjectId, row.subjectName, row.startedAt)
    if (kind === 'workflow') {
      const names = await workflowNamesOf(
        sources,
        [...newest.values()].map((item) => item.subjectId),
      )
      return [...newest.values()].map((item) => ({
        ...item,
        name: item.subjectId === null ? null : (names.get(item.subjectId) ?? null),
      }))
    }
    return [...newest.values()]
  }
}
