import {
  CompleteObservationReportQuerySchema,
  type ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { getAuthSessionRevision, getBaseUrl, getToken } from '@/stores/auth'
import { sha256Hex } from '@/lib/sha256'
import { discardObservationDefaultRange } from './observationDefaultRange'

const PREFIX = 'agent-workflow.observation-complete-bookmark/13:'
const rejectedIds = new Set<string>()

/** Storage retains a pointer only; the original GET must qualify every displayed fact. */
export async function observationReportBookmark(
  filters: ObservationOverviewQuery,
  taskId: string | undefined,
) {
  const base = getBaseUrl(),
    token = getToken(),
    revision = getAuthSessionRevision()
  const current = () =>
    base === getBaseUrl() && token === getToken() && revision === getAuthSessionRevision()
  let key: string | null = null
  try {
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        base,
        token,
        CompleteObservationReportQuerySchema.parse(filters),
        taskId ?? null,
      ]),
    )
    key = PREFIX + (await sha256Hex(bytes))
  } catch {
    // Unavailable browser persistence/digest leaves the original request path intact.
  }
  return {
    current,
    read(): string | null {
      try {
        const id = key && current() ? localStorage.getItem(key) : null
        return id && !rejectedIds.has(id) ? id : null
      } catch {
        return null
      }
    },
    remember(id: string) {
      try {
        if (key && current() && !rejectedIds.has(id)) localStorage.setItem(key, id)
      } catch {
        // A storage failure never changes the qualified original response.
      }
    },
  }
}

export function observationReportWasRejected(id: string): boolean {
  return rejectedIds.has(id)
}

/** Exact-ID removal cannot erase a different, subsequently completed report. */
export function discardObservationReportBookmark(id: string) {
  rejectedIds.add(id)
  discardObservationDefaultRange(id)
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) if (localStorage.getItem(key) === id) localStorage.removeItem(key)
  } catch {
    // Retiring the pointer is best effort; rejected facts remain hidden in this session.
  }
}
