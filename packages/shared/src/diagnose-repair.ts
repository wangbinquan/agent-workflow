// RFC-057 — Diagnose Panel repair option taxonomy (shared contract).
//
// The 13 lifecycle alert rules (R1/R2/C1/T1/T2/T3/U1/CR-1 + S1/S2/S3/S4/S5)
// each map to a fixed set of `optionId`s. Backend implements the
// `preflight` + `apply` functions per optionId; this file is the static
// contract both ends agree on so frontend can render UI without coupling
// to backend internals.
//
// New rule? Add it to `LIFECYCLE_ALERT_RULES` in lifecycle-alerts.ts AND
// add a non-empty option-id list here — both `REPAIR_OPTION_IDS satisfies
// Record<LifecycleAlertRule, ...>` and the backend's `REPAIR_OPTIONS`
// `satisfies Record<LifecycleAlertRule, RepairOptionDef[]>` will fail
// compilation until you do.

import { z } from 'zod'

import type { LifecycleAlertRule } from './lifecycle-alerts'

// ---------------------------------------------------------------------------
// Risk + option metadata
// ---------------------------------------------------------------------------

export const REPAIR_RISKS = ['low', 'medium', 'high'] as const
export type RepairRisk = (typeof REPAIR_RISKS)[number]

/** Static descriptor known by both ends — no apply function lives here. */
export interface RepairOptionMeta {
  /** Stable id e.g. 'S3.resurrect-review-run'. Format: `<rule>.<kebab>`. */
  id: string
  rule: LifecycleAlertRule
  /** i18n key for the button label. */
  labelKey: string
  /** i18n key for the explanatory paragraph. */
  descriptionKey: string
  risk: RepairRisk
  /** True ⟹ frontend renders second confirm modal with destructive styling. */
  destructive: boolean
  /**
   * RFC-108 T13 (AR-07): may the auto-repair loop apply this WITHOUT a human?
   * INVARIANT (enforced by `autoApplyInvariantHolds` + a property test):
   *   autoApplyEligible === true  ⟹  risk === 'low' && destructive === false
   * AND it must be a single-valued deterministic finalizer (no genuine human
   * choice among equally-valid recoveries). Omitted ⟹ false. The v1 set is
   * deliberately minimal (only `S4.kick-task`, per decision D5); expansion is
   * per-rule, each behind its own green idempotency oracle. The auto-loop also
   * requires the rule to have EXACTLY ONE eligible+available option at apply
   * time (see `selectAutoApplyOption`), so an ambiguous moment never auto-fires.
   */
  autoApplyEligible?: boolean
  /**
   * RFC-165 (F13-r4): true ⟹ applying this option restarts task execution
   * (resumeAfterApply / reviving DAG node runs). Generic resume semantics do
   * NOT hold for workgroup host tasks (the engine adopts only pending rows;
   * recovery is RFC-164 engine re-entry territory) — list/apply refuse these
   * options for workgroup tasks. Omitted ⟹ false (safe: cancel/demote-class
   * mutations that stop or downgrade a task stay available).
   */
  revivesExecution?: boolean
}

/** RFC-108 T13: the hard safety invariant for an auto-applicable repair option. */
export function autoApplyInvariantHolds(
  o: Pick<RepairOptionMeta, 'autoApplyEligible' | 'risk' | 'destructive'>,
): boolean {
  if (o.autoApplyEligible !== true) return true
  return o.risk === 'low' && o.destructive === false
}

/**
 * RFC-108 T13/T19: pick the SINGLE option the auto-repair loop may apply for an
 * alert, or null. Returns a value only when EXACTLY ONE option is both
 * `autoApplyEligible` AND `available` (preflight passed) — any ambiguity (zero
 * or multiple) escalates to a human. This is the gate that keeps the loop from
 * guessing among genuine human choices.
 */
export function selectAutoApplyOption(options: ReadonlyArray<RepairOption>): RepairOption | null {
  const candidates = options.filter((o) => o.autoApplyEligible === true && o.available)
  return candidates.length === 1 ? candidates[0]! : null
}

/** Backend-resolved option for a specific (alert, option). Includes preflight. */
export interface RepairOption extends RepairOptionMeta {
  /** False ⟹ option shown disabled with `unavailableReasonKey` tooltip. */
  available: boolean
  unavailableReasonKey?: string
  /** Human-readable bullet list of what apply() will do, rendered as <ol>. */
  previewSteps: ReadonlyArray<string>
}

export interface RepairOptionsResponse {
  alertId: string
  alertRule: LifecycleAlertRule
  options: ReadonlyArray<RepairOption>
}

// ---------------------------------------------------------------------------
// HTTP request / response schemas
// ---------------------------------------------------------------------------

/**
 * POST /api/tasks/:id/alerts/:alertId/repair body. `confirm` MUST be the
 * literal `true` — Zod rejects `false` / omission. Frontend's second-confirm
 * modal sets it; no other call path is expected.
 */
export const RepairRequestSchema = z.object({
  optionId: z.string().min(1),
  confirm: z.literal(true),
})

export type RepairRequest = z.infer<typeof RepairRequestSchema>

export type RepairOutcome = 'success' | 'preflight-stale' | 'apply-failed'

export interface RepairResponse {
  ok: boolean
  auditId: string
  outcome: RepairOutcome
  outcomeMessage?: string
  /** Alert IDs that the re-scan after apply found resolved. */
  resolvedAlertIds: ReadonlyArray<string>
  /** Any NEW alerts that surfaced after apply (lets UI re-render). */
  newAlerts: ReadonlyArray<{ id: string; rule: LifecycleAlertRule }>
}

// ---------------------------------------------------------------------------
// Static option-id taxonomy — backend's REPAIR_OPTIONS map must enumerate
// exactly these ids per rule. Compile-time satisfies + a runtime test
// (shared/tests/diagnose-repair.test.ts) lock the alignment.
// ---------------------------------------------------------------------------

export const REPAIR_OPTION_IDS = {
  R1: ['R1.approve-run', 'R1.unapprove-doc', 'R1.mark-task-failed'],
  R2: ['R2.demote-run-to-awaiting', 'R2.mark-task-failed'],
  C1: ['C1.resume-run', 'C1.reopen-session'],
  T1: ['T1.demote-task', 'T1.resurrect-review-run'],
  T2: ['T2.demote-task', 'T2.resurrect-clarify-run'],
  T3: ['T3.demote-task', 'T3.mark-task-failed'],
  U1: ['U1.cancel-older-keep-newest', 'U1.cancel-newer-keep-oldest'],
  'CR-1': ['CR-1.acknowledge', 'CR-1.retry-designer-rerun'],
  S1: ['S1.recreate-doc-version', 'S1.demote-task'],
  S2: ['S2.demote-task', 'S2.reopen-session'],
  S3: [
    'S3.resurrect-review-run',
    'S3.resurrect-clarify-run',
    'S3.demote-task',
    'S3.mark-task-failed',
  ],
  S4: ['S4.kick-task', 'S4.cancel-task'],
  // RFC-098 WP-8: the runtime fix for S5 is process-level (kill escalation /
  // orphan reaping / kill-then-proceed on cancel+resume); the repair option
  // is an acknowledge mirroring CR-1.acknowledge.
  S5: ['S5.acknowledge'],
  // RFC-108 T14: member-deadlock is detect-only (D4) — restoring a member is an
  // admin/user-management action outside the repair engine; the option is an
  // acknowledge.
  S6: ['S6.acknowledge'],
} as const satisfies Record<LifecycleAlertRule, readonly string[]>

export type RepairOptionId = (typeof REPAIR_OPTION_IDS)[keyof typeof REPAIR_OPTION_IDS][number]

export function isKnownRepairOptionId(s: string): s is RepairOptionId {
  for (const rule of Object.keys(REPAIR_OPTION_IDS) as LifecycleAlertRule[]) {
    if ((REPAIR_OPTION_IDS[rule] as readonly string[]).includes(s)) return true
  }
  return false
}

export function repairOptionIdsForRule(rule: LifecycleAlertRule): readonly string[] {
  return REPAIR_OPTION_IDS[rule]
}

export function ruleForOptionId(optionId: string): LifecycleAlertRule | null {
  for (const rule of Object.keys(REPAIR_OPTION_IDS) as LifecycleAlertRule[]) {
    if ((REPAIR_OPTION_IDS[rule] as readonly string[]).includes(optionId)) return rule
  }
  return null
}
