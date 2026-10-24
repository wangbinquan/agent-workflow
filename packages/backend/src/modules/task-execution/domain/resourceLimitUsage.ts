// RFC-395 II-b O3 — decode the existing human-wait ledger before crossing the owner boundary.
export interface CallHumanWait {
  readonly accumulatedMs: number
  readonly openSince: number | null
}

export function decodeCallHumanWait(json: string | null): CallHumanWait {
  if (json !== null && json !== '') {
    try {
      const parsed: unknown = JSON.parse(json)
      if (typeof parsed === 'object' && parsed !== null) {
        const o = parsed as { callHumanWaitMs?: unknown; callHumanWaitSince?: unknown }
        return {
          accumulatedMs:
            typeof o.callHumanWaitMs === 'number' && o.callHumanWaitMs >= 0 ? o.callHumanWaitMs : 0,
          openSince:
            typeof o.callHumanWaitSince === 'number' && o.callHumanWaitSince > 0
              ? o.callHumanWaitSince
              : null,
        }
      }
    } catch {
      // Malformed historical progress has always contributed zero human-wait time.
    }
  }
  return { accumulatedMs: 0, openSince: null }
}

export function callHumanWaitMs(wait: CallHumanWait, now: number): number {
  return wait.accumulatedMs + (wait.openSince === null ? 0 : Math.max(0, now - wait.openSince))
}

export function parseCallHumanWait(json: string | null, now: number): number {
  return callHumanWaitMs(decodeCallHumanWait(json), now)
}

/** Aggregate expressions are not column-decoded by every provider driver. */
export function decodeResourceLimitTokenTotal(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0
  if (typeof value === 'bigint') {
    const decoded = Number(value)
    return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const decoded = Number(value)
    return Number.isFinite(decoded) ? decoded : 0
  }
  return 0
}
