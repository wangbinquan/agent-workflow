// RFC-057 — Diagnose Panel repair option engine.
//
// Each lifecycle_alerts row (R1/R2/C1/T1/T2/T3/U1/CR-1/S1/S2/S3/S4/S5) maps
// to a typed set of repair options declared in `REPAIR_OPTIONS`. The two
// public entry points are:
//
//   listRepairOptionsForAlert(...)
//     → runs every option's `preflight` and reports `available` / preview /
//       unavailable reason. Powers the frontend RepairChoiceDialog.
//
//   applyRepairOption(...)
//     → re-runs preflight (guards against detail drift since the dialog
//       opened), writes a lifecycle_repair_audit row, runs `apply`,
//       re-scans invariants for the task, returns the resolved/new alerts.
//
// PR-A scope: S3 / T1 / R1 / U1 (4 rules, 11 options). PR-B fills the
// remaining 8 rules. The `satisfies` clause on REPAIR_OPTIONS allows empty
// arrays in PR-A; PR-B narrows it to require ≥ 1 option per rule.
//
// State machine: ALL node_run.status writes go through `transitionNodeRunStatus`
// or `setNodeRunStatus` (RFC-053 PR-B). Grep guard in
// `tests/lifecycle-repair-grep-guard.test.ts` enforces no naked status writes
// or row deletions from this file or the options-*.ts modules.

import { and, asc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  REPAIR_OPTION_IDS,
  type LifecycleAlertRule,
  type RepairOption,
  type RepairOptionsResponse,
  type RepairResponse,
  ruleForOptionId,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { lifecycleAlerts, lifecycleRepairAudit, tasks } from '@/db/schema'
import { runLifecycleInvariants, type LifecycleAlertRow } from '@/services/lifecycleInvariants'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import type { StartTaskDeps } from '@/services/task'
import { resumeTask } from '@/services/task'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

import { C1_OPTIONS } from './lifecycleRepair/options-C1'
import { CR1_OPTIONS } from './lifecycleRepair/options-CR1'
import { R1_OPTIONS } from './lifecycleRepair/options-R1'
import { R2_OPTIONS } from './lifecycleRepair/options-R2'
import { S1_OPTIONS } from './lifecycleRepair/options-S1'
import { S2_OPTIONS } from './lifecycleRepair/options-S2'
import { S3_OPTIONS } from './lifecycleRepair/options-S3'
import { S4_OPTIONS } from './lifecycleRepair/options-S4'
import { S5_OPTIONS } from './lifecycleRepair/options-S5'
import { T1_OPTIONS } from './lifecycleRepair/options-T1'
import { T2_OPTIONS } from './lifecycleRepair/options-T2'
import { T3_OPTIONS } from './lifecycleRepair/options-T3'
import { U1_OPTIONS } from './lifecycleRepair/options-U1'
import type {
  ApplyResult,
  ParsedLifecycleAlert,
  PreflightResult,
  RepairContext,
  RepairNodeRunRow,
  RepairOptionDef,
  RepairTaskRow,
} from './lifecycleRepair/types'

const log = createLogger('lifecycle.repair')

// ---------------------------------------------------------------------------
// Option taxonomy — every rule must appear; PR-A allows empty arrays for
// rules that are filled by PR-B.
// ---------------------------------------------------------------------------

export const REPAIR_OPTIONS = {
  R1: R1_OPTIONS,
  R2: R2_OPTIONS,
  C1: C1_OPTIONS,
  T1: T1_OPTIONS,
  T2: T2_OPTIONS,
  T3: T3_OPTIONS,
  U1: U1_OPTIONS,
  'CR-1': CR1_OPTIONS,
  S1: S1_OPTIONS,
  S2: S2_OPTIONS,
  S3: S3_OPTIONS,
  S4: S4_OPTIONS,
  S5: S5_OPTIONS,
} as const satisfies Record<LifecycleAlertRule, readonly [RepairOptionDef, ...RepairOptionDef[]]>

// Runtime guard: every implemented option id must appear in the shared
// REPAIR_OPTION_IDS taxonomy. Catches drift if a rule's option list is
// edited in isolation. Empty rules in PR-A are tolerated.
for (const rule of Object.keys(REPAIR_OPTIONS) as LifecycleAlertRule[]) {
  const expected = new Set(REPAIR_OPTION_IDS[rule] as readonly string[])
  for (const def of REPAIR_OPTIONS[rule]) {
    if (!expected.has(def.id)) {
      throw new Error(
        `REPAIR_OPTIONS.${rule} contains optionId '${def.id}' not in shared REPAIR_OPTION_IDS`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface ListRepairOptionsArgs {
  db: DbClient
  taskId: string
  alertId: string
  actorUserId: string | null
  appHome: string
  deps: StartTaskDeps
  now?: () => number
}

export async function listRepairOptionsForAlert(
  args: ListRepairOptionsArgs,
): Promise<RepairOptionsResponse> {
  const { db, taskId, alertId } = args
  const alert = await loadAlertOrThrow(db, taskId, alertId)
  if (alert.resolvedAt !== null) {
    throw new ConflictError(
      'alert-already-resolved',
      `lifecycle alert ${alertId} is already resolved`,
    )
  }
  const task = await loadTaskOrThrow(db, taskId)
  const now = args.now ?? Date.now

  const defs = REPAIR_OPTIONS[alert.rule] as readonly RepairOptionDef[]
  const rc: RepairContext = {
    db,
    alert,
    task,
    actorUserId: args.actorUserId,
    appHome: args.appHome,
    deps: args.deps,
    now,
  }
  const options: RepairOption[] = []
  for (const def of defs) {
    let pre: PreflightResult
    try {
      pre = await def.preflight(rc)
    } catch (err) {
      log.warn('preflight threw', {
        alertId,
        optionId: def.id,
        error: err instanceof Error ? err.message : String(err),
      })
      pre = {
        available: false,
        unavailableReasonKey: 'diagnose.repair.common.preflightThrew',
        previewSteps: [],
        ctx: {},
      }
    }
    const o: RepairOption = {
      id: def.id,
      rule: def.rule,
      labelKey: def.labelKey,
      descriptionKey: def.descriptionKey,
      risk: def.risk,
      destructive: def.destructive,
      available: pre.available,
      previewSteps: pre.previewSteps,
      ...(pre.unavailableReasonKey ? { unavailableReasonKey: pre.unavailableReasonKey } : {}),
    }
    options.push(o)
  }
  return {
    alertId: alert.id,
    alertRule: alert.rule,
    options,
  }
}

export interface ApplyRepairOptionArgs extends ListRepairOptionsArgs {
  optionId: string
  /** WS hook so the route layer can re-broadcast `lifecycle.alert` events. */
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
}

export async function applyRepairOption(args: ApplyRepairOptionArgs): Promise<RepairResponse> {
  const { db, taskId, alertId, optionId, actorUserId } = args
  const alert = await loadAlertOrThrow(db, taskId, alertId)
  if (alert.resolvedAt !== null) {
    throw new ConflictError(
      'alert-already-resolved',
      `lifecycle alert ${alertId} is already resolved`,
    )
  }
  const task = await loadTaskOrThrow(db, taskId)
  const expectedRule = ruleForOptionId(optionId)
  if (expectedRule === null) {
    throw new ValidationError(
      'unknown-repair-option',
      `optionId '${optionId}' is not a registered repair option`,
    )
  }
  if (expectedRule !== alert.rule) {
    throw new ValidationError(
      'repair-option-rule-mismatch',
      `optionId '${optionId}' belongs to rule '${expectedRule}', not alert.rule='${alert.rule}'`,
    )
  }

  const defs = REPAIR_OPTIONS[alert.rule] as readonly RepairOptionDef[]
  const def = defs.find((d) => d.id === optionId)
  if (def === undefined) {
    throw new ValidationError(
      'repair-option-not-implemented',
      `optionId '${optionId}' is in the shared taxonomy but not implemented yet`,
    )
  }

  const now = args.now ?? Date.now
  const rc: RepairContext = {
    db,
    alert,
    task,
    actorUserId,
    appHome: args.appHome,
    deps: args.deps,
    now,
  }

  // Re-run preflight to guard against detail drift since the dialog opened.
  const pre = await def.preflight(rc)
  if (!pre.available) {
    await writeAudit(db, {
      alert,
      optionId,
      actorUserId,
      beforeSnapshot: { reason: pre.unavailableReasonKey ?? 'unknown' },
      afterSnapshot: {},
      outcome: 'preflight-stale',
      outcomeMessage: pre.unavailableReasonKey ?? 'preflight reported unavailable',
      appliedAt: now(),
    })
    throw new ConflictError(
      'repair-preflight-stale',
      `preflight for '${optionId}' is no longer available (${pre.unavailableReasonKey ?? 'state drifted'}); re-diagnose to refresh`,
    )
  }

  let applyOut: ApplyResult
  try {
    applyOut = await def.apply(rc, pre)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('apply threw', { taskId, alertId, optionId, error: message })
    await writeAudit(db, {
      alert,
      optionId,
      actorUserId,
      beforeSnapshot: { reason: 'apply-threw' },
      afterSnapshot: {},
      outcome: 'apply-failed',
      outcomeMessage: message,
      appliedAt: now(),
    })
    // RFC-097: a task-status CAS loss inside apply means the task moved under
    // the operator's feet between preflight and the write — same situation as
    // a stale preflight. Re-map to the existing 409 contract (operator
    // re-diagnoses) instead of leaking the raw transition error code.
    if (
      err instanceof ConflictError &&
      (err.code === 'illegal-task-transition' || err.code === 'concurrent-task-transition')
    ) {
      throw new ConflictError(
        'repair-preflight-stale',
        `apply for '${optionId}' lost the task-status race (${message}); re-diagnose to refresh`,
      )
    }
    throw err
  }

  const auditId = await writeAudit(db, {
    alert,
    optionId,
    actorUserId,
    beforeSnapshot: applyOut.beforeSnapshot,
    afterSnapshot: applyOut.afterSnapshot,
    outcome: 'success',
    appliedAt: now(),
  })

  if (applyOut.resumeAfterApply === true) {
    try {
      await resumeTask(db, taskId, args.deps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('resume after apply failed', { taskId, alertId, optionId, error: message })
      return {
        ok: false,
        auditId,
        outcome: 'apply-failed',
        outcomeMessage: `mutations applied but resumeTask failed: ${message}`,
        resolvedAlertIds: [],
        newAlerts: [],
      }
    }
  }

  const beforeOpenIds = await loadOpenAlertIdsForTask(db, taskId)
  // After successful apply, resolve the target alert proactively — the operator
  // acknowledged it and made a change; the next-scan will surface a fresh row
  // if the violation persists. This avoids two stale states:
  //   1. STUCK_RULES alerts whose task ran past a terminal boundary (the
  //      detector skips terminal tasks, so it never reconciles them).
  //   2. Race between "apply commits" and "next scan tick" where the UI
  //      momentarily still shows the just-acted-on banner.
  await db
    .update(lifecycleAlerts)
    .set({ resolvedAt: now() })
    .where(and(eq(lifecycleAlerts.id, alert.id), isNull(lifecycleAlerts.resolvedAt)))
  await runLifecycleInvariants({
    db,
    scope: { taskId },
    now,
    ...(args.onAlert ? { onAlert: args.onAlert } : {}),
  })
  await runStuckTaskDetector({
    db,
    now,
    ...(args.onAlert ? { onAlert: args.onAlert } : {}),
    taskIdFilter: [taskId],
  })
  const afterOpenIds = await loadOpenAlertIdsForTask(db, taskId)
  const afterIdSet = new Set(afterOpenIds.map((r) => r.id))
  const resolvedIds = beforeOpenIds.filter((r) => !afterIdSet.has(r.id)).map((r) => r.id)
  const beforeIdSet = new Set(beforeOpenIds.map((r) => r.id))
  const newAlerts = afterOpenIds
    .filter((r) => !beforeIdSet.has(r.id))
    .map((r) => ({ id: r.id, rule: r.rule as LifecycleAlertRule }))

  return {
    ok: true,
    auditId,
    outcome: 'success',
    resolvedAlertIds: resolvedIds,
    newAlerts,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadAlertOrThrow(
  db: DbClient,
  taskId: string,
  alertId: string,
): Promise<ParsedLifecycleAlert> {
  const rows = await db
    .select()
    .from(lifecycleAlerts)
    .where(eq(lifecycleAlerts.id, alertId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('alert-not-found', `lifecycle_alerts row ${alertId} not found`)
  }
  if (row.taskId !== taskId) {
    throw new NotFoundError(
      'alert-not-on-task',
      `lifecycle_alerts row ${alertId} belongs to task ${row.taskId}, not ${taskId}`,
    )
  }
  let detail: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.detail)
    detail =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { raw: row.detail }
  } catch {
    detail = { raw: row.detail }
  }
  return {
    id: row.id,
    taskId: row.taskId,
    rule: row.rule as LifecycleAlertRule,
    severity: row.severity as 'warning' | 'error',
    detail,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
  }
}

async function loadTaskOrThrow(db: DbClient, taskId: string): Promise<RepairTaskRow> {
  const rows = await db
    .select({ id: tasks.id, status: tasks.status, workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return row
}

async function loadOpenAlertIdsForTask(
  db: DbClient,
  taskId: string,
): Promise<Array<{ id: string; rule: string }>> {
  return db
    .select({ id: lifecycleAlerts.id, rule: lifecycleAlerts.rule })
    .from(lifecycleAlerts)
    .where(and(eq(lifecycleAlerts.taskId, taskId), isNull(lifecycleAlerts.resolvedAt)))
    .orderBy(asc(lifecycleAlerts.detectedAt))
}

interface AuditInput {
  alert: ParsedLifecycleAlert
  optionId: string
  actorUserId: string | null
  beforeSnapshot: Record<string, unknown>
  afterSnapshot: Record<string, unknown>
  outcome: 'success' | 'preflight-stale' | 'apply-failed'
  outcomeMessage?: string
  appliedAt: number
}

async function writeAudit(db: DbClient, a: AuditInput): Promise<string> {
  const id = ulid()
  await db.insert(lifecycleRepairAudit).values({
    id,
    taskId: a.alert.taskId,
    alertId: a.alert.id,
    alertRule: a.alert.rule,
    alertDetailJson: JSON.stringify(a.alert.detail),
    optionId: a.optionId,
    actorUserId: a.actorUserId,
    beforeSnapshotJson: JSON.stringify(a.beforeSnapshot),
    afterSnapshotJson: JSON.stringify(a.afterSnapshot),
    outcome: a.outcome,
    outcomeMessage: a.outcomeMessage ?? null,
    appliedAt: a.appliedAt,
  })
  return id
}

// Re-export the internal types so route layer + tests can import them cleanly.
export type {
  ApplyResult,
  ParsedLifecycleAlert,
  PreflightResult,
  RepairContext,
  RepairNodeRunRow,
  RepairOptionDef,
  RepairTaskRow,
}
