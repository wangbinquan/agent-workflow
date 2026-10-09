import type { CompleteObservationReportContent } from '@agent-workflow/shared'

interface CompletedDefaultRange {
  readonly reportId: string
  readonly from: number
  readonly to: number
  readonly timezone: string
  readonly current: () => boolean
}

let completed: CompletedDefaultRange | null = null

/** Called only after the original response has qualified its exact report and scope. */
export function rememberObservationDefaultRange(
  content: CompleteObservationReportContent,
  current: () => boolean,
) {
  const { reportId, filters, taskId } = content.header
  try {
    if (
      !current() ||
      taskId !== null ||
      filters.cohort !== undefined ||
      filters.q !== undefined ||
      filters.status !== undefined ||
      filters.repository !== undefined ||
      filters.workflow !== undefined ||
      filters.selection !== undefined ||
      !Number.isSafeInteger(filters.from) ||
      !Number.isSafeInteger(filters.to) ||
      filters.from < 0 ||
      filters.to - filters.from !== 7 * 86400000 ||
      filters.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    )
      return
    completed = {
      reportId,
      from: filters.from,
      to: filters.to,
      timezone: filters.timezone,
      current,
    }
  } catch {
    // An unavailable identity/timezone primitive leaves the original route defaults intact.
  }
}

/** Only a range is returned. The original report GET still supplies and checks every fact. */
export function observationDefaultRange(): { readonly from: number; readonly to: number } | null {
  try {
    if (
      completed?.current() &&
      completed.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone
    )
      return { from: completed.from, to: completed.to }
  } catch {
    // Use the original initial-range path when the remembered scope is unavailable.
  }
  completed = null
  return null
}

export function discardObservationDefaultRange(reportId: string) {
  if (completed?.reportId === reportId) completed = null
}
