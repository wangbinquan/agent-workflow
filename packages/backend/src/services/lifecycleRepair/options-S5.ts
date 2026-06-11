// RFC-098 WP-8 — S5 repair options.
//
// S5: task.status='running', active node_run(s) exist, but no node_run_events
// have landed for ≥ the stuck threshold — the opencode child is wedged (e.g.
// trapped SIGTERM, hung MCP) or died without the runner settling the row.
// The runtime fix is process-level and already wired elsewhere by RFC-098:
// the runner's SIGTERM→SIGKILL escalation bounds new runs, boot orphan
// reaping group-kills survivors, and cancel/resume run kill-then-proceed pid
// governance before touching the worktree. By the time the operator sees
// this alert the actionable info is in the detail payload
// ({nodeRunId,nodeId,pid,lastEventTs} per active run). One option:
//
//   - S5.acknowledge — pure UI ack mirroring CR-1.acknowledge: resolve the
//     alert + audit row, no DB mutation. Recovery goes through the regular
//     task cancel/resume actions.

import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const S5_ACKNOWLEDGE: RepairOptionDef = {
  id: 'S5.acknowledge',
  rule: 'S5',
  labelKey: 'diagnose.repair.S5.acknowledge.label',
  descriptionKey: 'diagnose.repair.S5.acknowledge.desc',
  risk: 'low',
  destructive: false,
  // Always available — acknowledging is a UI-only operation; the engine
  // resolves the alert + writes an audit row even though nothing else moves.
  async preflight(): Promise<PreflightResult> {
    return {
      available: true,
      previewSteps: [
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. Inspect the active-run pids in the alert detail; cancel/resume the task to recover (RFC-098 group-kills live children before rollback).`,
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

export const S5_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [S5_ACKNOWLEDGE]
