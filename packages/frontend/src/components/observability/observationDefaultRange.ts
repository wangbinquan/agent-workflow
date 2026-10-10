import type { CompleteObservationReportContent } from '@agent-workflow/shared'
import { getAuthSessionRevision, getBaseUrl, getToken } from '@/stores/auth'
import { bytesToHex, sha256DigestJs } from '@/lib/sha256'

interface CompletedDefaultRange {
  readonly reportId: string
  readonly from: number
  readonly to: number
  readonly timezone: string
  readonly current: () => boolean
}

let completed: CompletedDefaultRange | null = null
const PREFIX = 'agent-workflow.observation-default-range/13:'
const retiredIds = new Set<string>()

function defaultRangeScope() {
  const base = getBaseUrl(),
    token = getToken(),
    revision = getAuthSessionRevision()
  if (!token) return null
  return {
    key:
      PREFIX + bytesToHex(sha256DigestJs(new TextEncoder().encode(JSON.stringify([base, token])))),
    current: () =>
      base === getBaseUrl() && token === getToken() && revision === getAuthSessionRevision(),
  }
}

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
    try {
      const scope = defaultRangeScope()
      if (scope?.current() && current())
        localStorage.setItem(
          scope.key,
          JSON.stringify({
            reportId,
            from: filters.from,
            to: filters.to,
            timezone: filters.timezone,
          }),
        )
    } catch {
      // Persistence is optional; the qualified in-memory range remains usable.
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
  if (completed) discardObservationDefaultRange(completed.reportId)
  try {
    const scope = defaultRangeScope()
    if (!scope?.current()) return null
    const raw = localStorage.getItem(scope.key)
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<Omit<CompletedDefaultRange, 'current'>> | null
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      Object.keys(saved).length !== 4 ||
      Object.keys(saved).some((key) => !['reportId', 'from', 'to', 'timezone'].includes(key)) ||
      typeof saved.reportId !== 'string' ||
      !saved.reportId ||
      retiredIds.has(saved.reportId) ||
      typeof saved.from !== 'number' ||
      typeof saved.to !== 'number' ||
      !Number.isSafeInteger(saved.from) ||
      !Number.isSafeInteger(saved.to) ||
      saved.from < 0 ||
      saved.to - saved.from !== 7 * 86400000 ||
      typeof saved.timezone !== 'string' ||
      saved.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ||
      !scope.current()
    )
      return null
    completed = {
      reportId: saved.reportId,
      from: saved.from,
      to: saved.to,
      timezone: saved.timezone,
      current: scope.current,
    }
    return { from: completed.from, to: completed.to }
  } catch {
    // A pointer cannot qualify facts; unavailable or invalid storage uses the original range.
  }
  return null
}

export function discardObservationDefaultRange(reportId: string) {
  retiredIds.add(reportId)
  if (completed?.reportId === reportId) completed = null
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
          reportId?: unknown
        } | null
        if (saved?.reportId === reportId) localStorage.removeItem(key)
      } catch {
        // An unrelated malformed pointer cannot prevent retiring this exact ID.
      }
    }
  } catch {
    // A failed removal must not restore a retired pointer in this application session.
  }
}
