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
//   - port-inactive:  RFC-306 — the target port is not carrying a value this
//                     round (its producer marked it `active="false"`, or the
//                     producing node was itself skipped). This is the exit
//                     condition for a loop whose body decides, per iteration,
//                     whether there is anything left to do.

export type ExitCondition =
  | { kind: 'port-empty'; nodeId: string; portName: string }
  | { kind: 'port-inactive'; nodeId: string; portName: string }
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
 * null when the input is malformed; the scheduler treats null as a hard error —
 * runLoopWrapperNode fails the wrapper with `wrapper-loop-exit-condition`
 * (scheduler.ts, search that literal) rather than looping or exiting early.
 * The validator forbids missing/malformed exit conditions, so the runtime
 * branch is a defense-in-depth backstop, not a reachable product path.
 * (2026-08-12 审计对账：此注释原先写反成 "always exit / terminates after
 * iteration 0"，与实际 fail 行为相反，已按源码修正。)
 */
export function parseExitCondition(raw: unknown): ExitCondition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.kind !== 'string' ||
    typeof r.nodeId !== 'string' ||
    r.nodeId.length === 0 ||
    typeof r.portName !== 'string' ||
    r.portName.length === 0
  ) {
    return null
  }
  if (r.kind === 'port-empty') {
    return { kind: 'port-empty', nodeId: r.nodeId, portName: r.portName }
  }
  if (r.kind === 'port-inactive') {
    return { kind: 'port-inactive', nodeId: r.nodeId, portName: r.portName }
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
    if (typeof r.n !== 'number' || !Number.isFinite(r.n) || !Number.isInteger(r.n) || r.n < 1) {
      return null
    }
    const sep = typeof r.separator === 'string' && r.separator.length > 0 ? r.separator : '\n'
    return { kind: 'port-count-lt', nodeId: r.nodeId, portName: r.portName, n: r.n, separator: sep }
  }
  return null
}

/** The port value one iteration produced, as the exit rule sees it. */
export interface ExitPortValue {
  content: string
  /** RFC-306: false ⇒ the port carried nothing this round (branch closed). */
  active: boolean
}

/**
 * Evaluate an exit condition against the current iteration's port value.
 *
 * RFC-306 — how an INACTIVE port answers each rule (design §8). The asymmetry is
 * deliberate and was decided explicitly, not derived:
 *
 *   port-inactive  → TRUE.  The rule exists for exactly this.
 *   port-empty     → TRUE.  "Produced nothing" and "produced empty" are the same
 *                    thing to an author who wrote `port-empty` before branches
 *                    existed. Answering false here would let a pre-RFC-306 loop
 *                    that closes its own branch run to max_iterations and fail —
 *                    a regression introduced by a feature the loop never used.
 *   port-not-empty → false. Its author is waiting for real content; nothing is
 *                    not content.
 *   port-equals    → false. An absent value equals nothing, not even ''. (An
 *                    author who wants "closed ⇒ exit" writes port-inactive.)
 *   port-count-lt  → false. Refusing to count a value that was never produced
 *                    keeps `count < n` from firing on absence, which would read
 *                    as "the work shrank" when in fact no work was reported.
 *
 * With `active: true` every branch below is byte-identical to pre-RFC-306, which
 * is what the existing exit-condition suites lock.
 */
export function evaluateExitCondition(cond: ExitCondition, value: ExitPortValue): boolean {
  if (cond.kind === 'port-inactive') return !value.active
  if (!value.active) return cond.kind === 'port-empty'
  const portContent = value.content
  if (cond.kind === 'port-empty') return portContent.trim() === ''
  if (cond.kind === 'port-not-empty') return portContent.trim() !== ''
  if (cond.kind === 'port-equals') return portContent === cond.value
  // port-count-lt
  const sep = cond.separator ?? '\n'
  const count =
    portContent.length === 0 ? 0 : portContent.split(sep).filter((p) => p.length > 0).length
  return count < cond.n
}
