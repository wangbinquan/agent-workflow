// Loop wrapper exit condition evaluation (design.md §6.4).
//
// Built-in shapes:
//   - port-empty:     target node's `port` content (trimmed) is empty
//   - port-not-empty: target node's `port` content (trimmed) is non-empty
//                     — added for the RFC-023 clarify use case: loop on
//                     "agent asked → user answered → agent retried" until
//                     the agent actually produces an output port (so the
//                     port stops being empty), at which point exit.
//   - port-equals:    target node's `port` content equals the configured value
//   - port-count-lt:  count of separator-delimited tokens is < n (default sep '\n')

export type ExitCondition =
  | { kind: 'port-empty'; nodeId: string; portName: string }
  | { kind: 'port-not-empty'; nodeId: string; portName: string }
  | { kind: 'port-equals'; nodeId: string; portName: string; value: string }
  | {
      kind: 'port-count-lt'
      nodeId: string
      portName: string
      n: number
      separator?: string
    }

/**
 * Parse an unknown wrapper-loop exitCondition shape into a typed union. Returns
 * null when the input is malformed; the scheduler treats null as "always exit"
 * (so the loop terminates after iteration 0) — but the validator forbids
 * missing/malformed exit conditions, so this should not happen at runtime.
 */
export function parseExitCondition(raw: unknown): ExitCondition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.kind !== 'string' ||
    typeof r.nodeId !== 'string' ||
    typeof r.portName !== 'string'
  ) {
    return null
  }
  if (r.kind === 'port-empty') {
    return { kind: 'port-empty', nodeId: r.nodeId, portName: r.portName }
  }
  if (r.kind === 'port-not-empty') {
    return { kind: 'port-not-empty', nodeId: r.nodeId, portName: r.portName }
  }
  if (r.kind === 'port-equals') {
    return {
      kind: 'port-equals',
      nodeId: r.nodeId,
      portName: r.portName,
      value: typeof r.value === 'string' ? r.value : '',
    }
  }
  if (r.kind === 'port-count-lt') {
    const n = typeof r.n === 'number' && Number.isFinite(r.n) ? r.n : 0
    const sep = typeof r.separator === 'string' && r.separator.length > 0 ? r.separator : '\n'
    return { kind: 'port-count-lt', nodeId: r.nodeId, portName: r.portName, n, separator: sep }
  }
  return null
}

/** Evaluate an exit condition against the current iteration's port content. */
export function evaluateExitCondition(cond: ExitCondition, portContent: string): boolean {
  if (cond.kind === 'port-empty') return portContent.trim() === ''
  if (cond.kind === 'port-not-empty') return portContent.trim() !== ''
  if (cond.kind === 'port-equals') return portContent === cond.value
  // port-count-lt
  const sep = cond.separator ?? '\n'
  const count =
    portContent.length === 0 ? 0 : portContent.split(sep).filter((p) => p.length > 0).length
  return count < cond.n
}
