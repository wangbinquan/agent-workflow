// RFC-452 — response shapes of the task diagnostics endpoints: `GET /api/tasks/:id/alerts`,
// `GET /api/tasks/:id/recovery-events` and `POST /api/tasks/:id/diagnose`. task-execution's `TaskDiagnostics`
// contract returns these inferred types and the route serializes them unchanged. A lifecycle alert's `detail` is the
// rule-specific JSON object stored with the alert, so it stays an open record.

import { z } from 'zod'

import { LIFECYCLE_ALERT_RULES } from '../lifecycle-alerts'

/** One open lifecycle alert (`lifecycle_alerts` row with its detail decoded). */
export const TaskLifecycleAlertSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  rule: z.enum(LIFECYCLE_ALERT_RULES),
  severity: z.enum(['warning', 'error']),
  detail: z.record(z.string(), z.unknown()),
  detectedAt: z.number(),
})
export type TaskLifecycleAlert = z.infer<typeof TaskLifecycleAlertSchema>

/** `GET /api/tasks/:id/alerts` — open alerts, oldest first. */
export const TaskAlertsResponseSchema = z.object({
  alerts: z.array(TaskLifecycleAlertSchema),
})
export type TaskAlertsResponse = z.infer<typeof TaskAlertsResponseSchema>

/** One system recovery audit row (`recovery_events`), JSON columns kept as stored. */
export const TaskRecoveryEventSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  actor: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  beforeJson: z.string().nullable(),
  afterJson: z.string().nullable(),
  createdAt: z.number(),
})
export type TaskRecoveryEvent = z.infer<typeof TaskRecoveryEventSchema>

/** `GET /api/tasks/:id/recovery-events` — newest first, plus whether auto-recovery is quarantined. */
export const TaskRecoveryEventsResponseSchema = z.object({
  events: z.array(TaskRecoveryEventSchema),
  suspended: z.boolean(),
})
export type TaskRecoveryEventsResponse = z.infer<typeof TaskRecoveryEventsResponseSchema>

/** A diagnose result row: an open alert plus its resolution time (always null while open). */
export const TaskDiagnoseAlertSchema = TaskLifecycleAlertSchema.extend({
  resolvedAt: z.number().nullable(),
})
export type TaskDiagnoseAlert = z.infer<typeof TaskDiagnoseAlertSchema>

/** `POST /api/tasks/:id/diagnose` — the live invariant scan merged with the open stuck-rule rows. */
export const TaskDiagnoseResponseSchema = z.object({
  scanned: z.number(),
  newAlerts: z.number(),
  promotedAlerts: z.number(),
  resolvedAlerts: z.number(),
  openAlerts: z.array(TaskDiagnoseAlertSchema),
})
export type TaskDiagnoseResponse = z.infer<typeof TaskDiagnoseResponseSchema>
