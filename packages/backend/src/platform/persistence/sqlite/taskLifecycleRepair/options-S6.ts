// RFC-108 T14 (AR-06) — S6 SQLite repair options.
//
// S6: an awaiting_review / awaiting_human task whose every member (owner +
// collaborators) is non-active (disabled / never-activated) — nobody on the
// task's answer-rights boundary can respond, so the review/clarify is
// deadlocked. Per decision D4 this is DETECT-ONLY: actually un-sticking it means
// restoring/re-inviting a user or transferring ownership — an admin
// user-management action that lives outside the repair engine. So the single
// option is an acknowledge (mirrors S5.acknowledge / CR-1.acknowledge): resolve
// the alert + audit row, mutate nothing.

import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const S6_ACKNOWLEDGE: RepairOptionDef = {
  id: 'S6.acknowledge',
  rule: 'S6',
  labelKey: 'diagnose.repair.S6.acknowledge.label',
  descriptionKey: 'diagnose.repair.S6.acknowledge.desc',
  risk: 'low',
  destructive: false,
  async preflight(): Promise<PreflightResult> {
    return {
      available: true,
      previewSteps: [
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. Restore a member: re-activate a disabled user, invite a new collaborator, or transfer ownership so someone can answer.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    return {
      beforeSnapshot: { alert: { id: rc.alert.id, rule: rc.alert.rule } },
      afterSnapshot: { alert: { id: rc.alert.id, action: 'acknowledged' } },
    }
  },
}

export const S6_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [S6_ACKNOWLEDGE]
