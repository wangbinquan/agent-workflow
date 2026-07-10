// RFC-164 PR-4 → RFC-165 — workgroup launch error mapping for the /tasks/new
// wizard (the body composition lives in lib/task-wizard's
// buildWorkgroupStartBody; the standalone /workgroups/launch page is retired).
//
// `workgroupLaunchErrorMessage` maps the launch endpoint's three 422 codes to
// friendly localized copy (unknown codes fall back to describeApiError).

import { ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'

export type WorkgroupLaunchReadinessReason = 'no-agent-member' | 'leader-missing'

/**
 * Structured classification of a launch failure (pure — no i18n). The three
 * codes come from the backend launch path:
 *   - workgroup-not-ready              (services/workgroupLaunch.ts, with
 *                                       details.reasons from the shared
 *                                       workgroupLaunchReadiness oracle)
 *   - workgroup-human-members-unsupported (temporary guard on older daemons —
 *                                       copy must say a later version opens it)
 *   - workgroup-launch-invalid         (routes/workgroups.ts schema 422)
 */
export function classifyWorkgroupLaunchError(
  err: unknown,
):
  | { kind: 'not-ready'; reasons: WorkgroupLaunchReadinessReason[] }
  | { kind: 'human-members-unsupported' }
  | { kind: 'invalid-payload' }
  | { kind: 'other' } {
  if (!(err instanceof ApiError)) return { kind: 'other' }
  if (err.code === 'workgroup-not-ready') {
    const raw =
      typeof err.details === 'object' && err.details !== null
        ? (err.details as { reasons?: unknown }).reasons
        : undefined
    const reasons = (Array.isArray(raw) ? raw : []).filter(
      (r): r is WorkgroupLaunchReadinessReason => r === 'no-agent-member' || r === 'leader-missing',
    )
    return { kind: 'not-ready', reasons }
  }
  if (err.code === 'workgroup-human-members-unsupported') {
    return { kind: 'human-members-unsupported' }
  }
  if (err.code === 'workgroup-launch-invalid') return { kind: 'invalid-payload' }
  return { kind: 'other' }
}

/** Localized message for a launch failure (t = i18next translate). */
export function workgroupLaunchErrorMessage(err: unknown, t: (key: string) => string): string {
  const classified = classifyWorkgroupLaunchError(err)
  switch (classified.kind) {
    case 'not-ready': {
      const parts = classified.reasons.map((r) =>
        r === 'no-agent-member'
          ? t('workgroups.readiness.noAgentMember')
          : t('workgroups.readiness.leaderMissing'),
      )
      return [t('workgroups.launch.notReady'), ...parts].join(' ')
    }
    case 'human-members-unsupported':
      return t('workgroups.launch.humanMembersUnsupported')
    case 'invalid-payload':
      return t('workgroups.launch.invalidPayload')
    case 'other':
      return describeApiError(err)
  }
}
