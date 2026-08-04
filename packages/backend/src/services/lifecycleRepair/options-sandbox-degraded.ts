// RFC-205 / 2026-08-04 sandbox audit — `sandbox-degraded` repair options.
//
// The alert says: `sandboxMode` is `warn` and the host could not provide the
// containment boundary, so this task ran with a reduced (or absent) one. Every
// actual remedy is on the HOST or in Settings — install bubblewrap, enable
// unprivileged user namespaces, fix the provider's ownership chain, or accept
// the trade by leaving the mode at `warn`. None of that is a data mutation the
// repair engine can perform, so — exactly like S5/S6 — the single option is an
// acknowledge: resolve the alert + write the audit row, mutate nothing.
//
// It has to EXIST, though: the diagnose panel renders a repair button for every
// open alert unconditionally, and `listRepairOptionsForAlert` used to do an
// unchecked `REPAIR_OPTIONS[alert.rule]` — a rule with no entry produced
// `undefined`, `for (const def of undefined)` threw, and the user pressing the
// only affordance in the panel got a bare HTTP 500.

import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const SANDBOX_DEGRADED_ACKNOWLEDGE: RepairOptionDef = {
  id: 'sandbox-degraded.acknowledge',
  rule: 'sandbox-degraded',
  labelKey: 'diagnose.repair.sandbox-degraded.acknowledge.label',
  descriptionKey: 'diagnose.repair.sandbox-degraded.acknowledge.desc',
  risk: 'low',
  destructive: false,
  async preflight(): Promise<PreflightResult> {
    return {
      available: true,
      previewSteps: [
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. Fix the host instead: run \`agent-workflow sandbox\` on the server for install/repair guidance, or change Settings → Runtime → sandbox mode.`,
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

export const SANDBOX_DEGRADED_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  SANDBOX_DEGRADED_ACKNOWLEDGE,
]
