// RFC-354 T4 — `agent-workflow doctor --backfill-containers`: the manual entry
// of the one-shot frame backfill the daemon runs at boot (migration 0223 adds
// the frame columns but cannot fill them from SQL). Forces a re-walk of every
// task — idempotent, rows that already carry a frame are left alone.
//
// Same gate as `db compact`: the walk rewrites node_runs rows the scheduler
// owns while a task runs, so it refuses while the daemon is up.

import {
  runFrameBackfillOnBoot,
  type FrameBackfillDatabase,
  type FrameBackfillReport,
} from '@/modules/task-execution/composition/frameBackfill'
import { isProcessAlive } from '@/util/process'
import { readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface FrameBackfillCommandResult {
  status: 'ok' | 'daemon-running'
  output: string
}

export function formatFrameBackfillReport(report: FrameBackfillReport): string {
  const lines = [
    `frame backfill: ${report.tasks} task(s) walked, ${report.rowsUpdated} node run(s) and ${report.roundsUpdated} clarify round(s) updated`,
  ]
  if (report.unreadableTasks.length > 0) {
    lines.push(
      `  ${report.unreadableTasks.length} task(s) skipped: workflow snapshot unreadable (${report.unreadableTasks.slice(0, 5).join(', ')}${report.unreadableTasks.length > 5 ? ', …' : ''})`,
    )
  }
  if (report.unresolvedRows > 0) {
    lines.push(
      `  ${report.unresolvedRows} nested row(s) left at the top scope: no generation row was minted before them`,
    )
  }
  return `${lines.join('\n')}\n`
}

export async function frameBackfillCommand(input: {
  readonly openDatabase: () => Promise<{
    readonly database: FrameBackfillDatabase
    readonly close: () => Promise<void>
  }>
  readonly daemonPid?: () => number | null
}): Promise<FrameBackfillCommandResult> {
  const pid = (input.daemonPid ?? (() => readPidFromLock(Paths.lock)))()
  if (pid !== null && isProcessAlive(pid)) {
    return {
      status: 'daemon-running',
      output:
        `daemon is running (pid ${pid}) — the frame backfill rewrites node_runs rows the\n` +
        `scheduler owns while tasks run (it already ran once at that daemon's boot).\n` +
        `Stop it first:  agent-workflow stop\n`,
    }
  }
  const opened = await input.openDatabase()
  try {
    const report = await runFrameBackfillOnBoot(opened.database, { force: true })
    return { status: 'ok', output: formatFrameBackfillReport(report) }
  } finally {
    await opened.close()
  }
}
