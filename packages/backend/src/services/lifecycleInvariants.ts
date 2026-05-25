// RFC-061 follow-up — legacy invariants scan retired.
//
// The legacy RFC-053 P-3 scan ran seven invariants (R1/R2/C1/T1/T2/
// T3/U1/CR-1) across doc_versions / clarify_sessions / cross_clarify_
// sessions / node_runs. Every one of those source tables is on the
// drop list (RFC-061 follow-up); the actor expresses review / clarify
// state via the suspensions projection, and `tasks.status` is no
// longer a primary signal (the actor keeps the task at `running`
// while a logical_run is `suspended`). Re-implementing the same
// invariants on the projection lands with RFC-062 (S5
// scheduler-stalled + suspensions-keyed R*/C*/T* rewrite).
//
// We keep the export surface (types + enums + reconcileLifecycleAlerts
// helper, since reconcile only touches the `lifecycle_alerts` table
// which survives the cleanup), but `runLifecycleInvariants` returns
// zero findings.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { LifecycleAlertRule as SharedLifecycleAlertRule } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { lifecycleAlerts } from '@/db/schema'

const HOUR_MS = 3_600_000
const GRACE_MS = 24 * HOUR_MS

export type InvariantRule = 'R1' | 'R2' | 'C1' | 'T1' | 'T2' | 'T3' | 'U1' | 'CR-1'
export type StuckRule = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export type LifecycleAlertRule = SharedLifecycleAlertRule

type _AssertBackendSubsetOfShared = InvariantRule | StuckRule extends SharedLifecycleAlertRule
  ? true
  : never
type _AssertSharedSubsetOfBackend = SharedLifecycleAlertRule extends InvariantRule | StuckRule
  ? true
  : never
const _LIFECYCLE_RULE_UNION_GUARD: [_AssertBackendSubsetOfShared, _AssertSharedSubsetOfBackend] = [
  true,
  true,
]

export type InvariantSeverity = 'warning' | 'error'

export const INVARIANT_RULES: readonly InvariantRule[] = [
  'R1',
  'R2',
  'C1',
  'T1',
  'T2',
  'T3',
  'U1',
  'CR-1',
]

export const STUCK_RULES: readonly StuckRule[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']

export interface LifecycleInvariantFinding {
  taskId: string
  rule: InvariantRule
  detail: Record<string, unknown>
}

export interface LifecycleAlertFinding {
  taskId: string
  rule: LifecycleAlertRule
  detail: Record<string, unknown>
}

export interface LifecycleAlertRow {
  id: string
  taskId: string
  rule: LifecycleAlertRule
  severity: InvariantSeverity
  detail: Record<string, unknown>
  detectedAt: number
  resolvedAt: number | null
}

export type InvariantScope = { taskId: string } | { since: number } | { all: true }

export interface RunLifecycleInvariantsArgs {
  db: DbClient
  scope?: InvariantScope
  now?: () => number
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
}

export interface RunLifecycleInvariantsResult {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

export async function runLifecycleInvariants(
  _args: RunLifecycleInvariantsArgs,
): Promise<RunLifecycleInvariantsResult> {
  return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
}

export function startLifecycleInvariantsLoop(_opts: {
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  intervalMs?: number
  bootDelayMs?: number
}): { stop: () => void } {
  return { stop: () => {} }
}

export interface ReconcileLifecycleAlertsResult {
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

/**
 * Diff `findings` against currently-open lifecycle_alerts rows whose
 * `rule` is in `ownedRules` and reconcile: insert new findings as
 * severity='warning', promote existing warnings past the 24h grace
 * window to 'error', mark missing findings resolved. Touches only
 * the lifecycle_alerts table — preserved through the RFC-061 cleanup.
 */
export async function reconcileLifecycleAlerts(args: {
  db: DbClient
  taskIds: string[]
  findings: LifecycleAlertFinding[]
  now: number
  ownedRules: readonly LifecycleAlertRule[]
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
}): Promise<ReconcileLifecycleAlertsResult> {
  const { db, taskIds, findings, now, ownedRules, onAlert } = args
  const openRows =
    taskIds.length === 0 || ownedRules.length === 0
      ? []
      : await db
          .select()
          .from(lifecycleAlerts)
          .where(
            and(
              inArray(lifecycleAlerts.taskId, taskIds),
              inArray(lifecycleAlerts.rule, ownedRules as string[]),
              isNull(lifecycleAlerts.resolvedAt),
            ),
          )

  const openByKey = new Map<string, (typeof openRows)[number]>()
  for (const r of openRows) openByKey.set(keyOf(r.taskId, r.rule), r)

  const findingByKey = new Map<string, LifecycleAlertFinding>()
  for (const f of findings) findingByKey.set(keyOf(f.taskId, f.rule), f)

  let newCount = 0
  let promotedCount = 0
  let resolvedCount = 0
  const open: LifecycleAlertRow[] = []

  for (const r of openRows) {
    const k = keyOf(r.taskId, r.rule)
    if (!findingByKey.has(k)) {
      await db.update(lifecycleAlerts).set({ resolvedAt: now }).where(eq(lifecycleAlerts.id, r.id))
      resolvedCount++
    }
  }

  for (const f of findings) {
    const k = keyOf(f.taskId, f.rule)
    const existing = openByKey.get(k)
    const detailJson = JSON.stringify(f.detail)
    if (existing === undefined) {
      const id = ulid()
      await db.insert(lifecycleAlerts).values({
        id,
        taskId: f.taskId,
        rule: f.rule,
        severity: 'warning',
        detail: detailJson,
        detectedAt: now,
        resolvedAt: null,
      })
      newCount++
      const row: LifecycleAlertRow = {
        id,
        taskId: f.taskId,
        rule: f.rule,
        severity: 'warning',
        detail: f.detail,
        detectedAt: now,
        resolvedAt: null,
      }
      open.push(row)
      onAlert?.(row, 'new')
    } else {
      const sev = (
        existing.severity === 'warning' && now - existing.detectedAt >= GRACE_MS
          ? 'error'
          : existing.severity
      ) as InvariantSeverity
      const promoted = sev !== existing.severity
      await db
        .update(lifecycleAlerts)
        .set({ severity: sev, detail: detailJson })
        .where(eq(lifecycleAlerts.id, existing.id))
      if (promoted) promotedCount++
      const row: LifecycleAlertRow = {
        id: existing.id,
        taskId: f.taskId,
        rule: f.rule,
        severity: sev,
        detail: f.detail,
        detectedAt: existing.detectedAt,
        resolvedAt: null,
      }
      open.push(row)
      if (promoted) onAlert?.(row, 'promoted')
    }
  }

  return {
    newAlerts: newCount,
    promotedAlerts: promotedCount,
    resolvedAlerts: resolvedCount,
    openAlerts: open,
  }
}

function keyOf(taskId: string, rule: string): string {
  return `${taskId}\x00${rule}`
}
