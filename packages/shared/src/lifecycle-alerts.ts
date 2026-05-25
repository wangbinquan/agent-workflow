// RFC-057 — canonical lifecycle alert rule list shared across backend +
// frontend + repair-option taxonomy. Mirrors `InvariantRule | StuckRule`
// in `packages/backend/src/services/lifecycleInvariants.ts`, but lives in
// shared so the diagnose-repair option map (rule → option[]) can satisfy
// the same union at compile time.

export const LIFECYCLE_ALERT_RULES = [
  // invariants (lifecycleInvariants.ts — legacy R/C/T/U/CR rules; the
  // RFC-061 follow-up no-ops these scanners, but the enum stays so
  // pre-RFC-061 lifecycle_alerts rows retain a stable rule name).
  'R1',
  'R2',
  'C1',
  'T1',
  'T2',
  'T3',
  'U1',
  'CR-1',
  // legacy stuck-task detector rules — no longer emitted by the RFC-
  // 061 rewritten stuckTaskDetector.ts. Stay in the enum so historic
  // rows render with a known label.
  'S1',
  'S2',
  'S3',
  'S4',
  // RFC-061 follow-up: projection-keyed stuck rules.
  // S5: tasks.status='running' AND now - max(events.ts) > threshold
  //     (scheduler stall — actor or runner silently stopped emitting).
  // S6: tasks.status='running' AND an open user-awaited suspension is
  //     older than the threshold (clarify / review the user hasn't
  //     answered in a long time).
  'S5',
  'S6',
] as const

export type LifecycleAlertRule = (typeof LIFECYCLE_ALERT_RULES)[number]

export type LifecycleAlertSeverity = 'warning' | 'error'

export function isLifecycleAlertRule(s: string): s is LifecycleAlertRule {
  return (LIFECYCLE_ALERT_RULES as readonly string[]).includes(s)
}
