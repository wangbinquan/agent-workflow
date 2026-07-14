// RFC-108 T18 (AR-03) — boot auto-resume (DEFAULT OFF, decision D1).
//
// `reapOrphanRuns` flips every task that was running across a daemon restart to
// `interrupted` (errorSummary='daemon-restart') and then waits for a human to
// click Resume. When `autoResumeOnBoot` is enabled, this closes that loop: each
// such task is re-driven automatically AT BOOT, but only through every guard the
// rest of RFC-108 built —
//   • circuit-breaker  (recordAutoRecoveryAttempt → skip if it quarantines),
//   • quarantine flag   (isAutoRecoverySuspended → skip),
//   • driver lease      (withDriverLease → never race a human / another actor),
//   • recovery audit     (a recovery_events row per resume),
//   • resumeTask itself  (CAS ownership lock + snapshot-lost / live-child-survived
//                         escalation already refuse unsafe resumes and the
//                         breaker counts those failures toward quarantine).
//
// The actual resume is injected so this stays unit-testable without the full
// launch machinery; start.ts passes a thunk that calls resumeTask with real deps.

import { and, eq } from 'drizzle-orm'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { withDriverLease } from '@/services/driverLease'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type BreakerConfig,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '@/services/recoveryBreaker'
import { createLogger } from '@/util/log'

const log = createLogger('auto-resume')

const HOLDER = 'boot-auto-resume'

export interface AutoResumeOptions {
  db: DbClient
  breaker: BreakerConfig
  /** Resume one task. Throws on an unsafe/failed resume (counted by the breaker). */
  resume: (taskId: string) => Promise<void>
  now?: () => number
}

export interface AutoResumeResult {
  resumed: string[]
  skipped: string[]
}

/**
 * Auto-resume every task that a daemon restart left `interrupted`. Idempotent:
 * resumeTask's CAS ownership claim means a task already being driven is skipped;
 * a second pass finds nothing because successful resumes leave `running`/terminal.
 */
export async function autoResumeInterruptedTasks(
  opts: AutoResumeOptions,
): Promise<AutoResumeResult> {
  const { db, breaker, resume } = opts
  const now = opts.now ?? Date.now
  const rows = await db
    .select({
      id: tasks.id,
      workgroupId: tasks.workgroupId,
      workgroupConfigJson: tasks.workgroupConfigJson,
    })
    .from(tasks)
    .where(
      and(eq(tasks.status, 'interrupted'), eq(tasks.errorSummary, DAEMON_RESTART_ERROR_SUMMARY)),
    )
  // RFC-186 PR-2 (audit §5 F1): turn-engine workgroups (leader_worker /
  // free_collab) are NOW resumable — `resumeTask`→`runTask`→`runWorkgroupEngine`
  // re-derives everything from durable rows, adopts pending host runs, and (PR-2)
  // reconciles a `running` assignment whose node_run is terminal. The old RFC-165
  // exclusion (`!isTurnEngineWorkgroupTask`) that left them `interrupted` forever
  // — the direct cause of 3/10 production tasks wedged permanently — is removed.
  // Single-agent host + dynamic_workflow were already included.
  const candidates = rows

  const resumed: string[] = []
  const skipped: string[] = []
  for (const t of candidates) {
    if (await isAutoRecoverySuspended(db, t.id)) {
      skipped.push(t.id)
      continue
    }
    const { suspended } = await recordAutoRecoveryAttempt(db, t.id, breaker, now())
    if (suspended) {
      skipped.push(t.id)
      continue
    }
    const ran = await withDriverLease(t.id, HOLDER, 'auto-resume', async () => {
      try {
        await resume(t.id)
        await recordRecoveryEvent(db, {
          taskId: t.id,
          kind: 'auto-resume',
          reason: 'autoResumeOnBoot',
          before: { status: 'interrupted' },
          after: { status: 'pending' },
          now: now(),
        })
        return true
      } catch (err) {
        // resumeTask refused (snapshot-lost / live-child-survived already
        // escalated + audited) or the launch failed; the breaker counted the
        // attempt, so a deterministic crash-loop quarantines after N.
        log.warn('auto-resume failed', {
          taskId: t.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    })
    if (ran === true) resumed.push(t.id)
    else skipped.push(t.id)
  }
  if (resumed.length > 0 || skipped.length > 0) {
    log.info('boot auto-resume swept interrupted tasks', {
      resumed: resumed.length,
      skipped: skipped.length,
    })
  }
  return { resumed, skipped }
}
