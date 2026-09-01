// RFC-057 — common SQLite query helpers shared between option modules.
// Living in a sibling file (not the engine entry) avoids cycles.

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { isTaskActive } from '@/services/task'

import type { PreflightResult, RepairNodeRunRow } from './types'

/** RFC-097 (audit S-23): repair options that flip task status and/or
 * resumeAfterApply must refuse while an in-process scheduler loop owns the
 * task — a repair write would race the live driver (second scheduler kicked
 * under the first, or the live loop's own CAS clobbered). Returns the canned
 * unavailable PreflightResult, or null when no scheduler is attached.
 * Note for tests: harness-built tasks never sit in task.ts's activeTasks map,
 * so this gate only fires when a real runTask is attached (see
 * rfc097-repair-liveness.test.ts). */
export function schedulerLivenessGate(rc: { task: { id: string } }): PreflightResult | null {
  if (!isTaskActive(rc.task.id)) return null
  return {
    available: false,
    unavailableReasonKey: 'diagnose.repair.common.schedulerActive',
    previewSteps: [],
    ctx: {},
  }
}

const NODE_RUN_COLS = {
  id: nodeRuns.id,
  nodeId: nodeRuns.nodeId,
  status: nodeRuns.status,
  retryIndex: nodeRuns.retryIndex,
  reviewIteration: nodeRuns.reviewIteration,
  shardKey: nodeRuns.shardKey,
  iteration: nodeRuns.iteration,
}

export async function loadNodeRun(
  db: DbClient,
  nodeRunId: string,
): Promise<RepairNodeRunRow | null> {
  const rows = await db
    .select(NODE_RUN_COLS)
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  return rows[0] ?? null
}

// RFC-096: `loadNodeRunsForNode` was deleted — a dead export (zero call sites
// since its RFC-057 introduction) whose `desc(retryIndex)` ordering was one of
// the audit S-13 freshest-row forks.

export async function loadAllNodeRunsForTask(
  db: DbClient,
  taskId: string,
): Promise<RepairNodeRunRow[]> {
  return db.select(NODE_RUN_COLS).from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
}

/** TERMINAL excluding 'done' — used by "the row got force-terminated by orphan
 * reap / shutdown and we want to bring it back to life" preflights. */
export const TERMINAL_NON_DONE = ['failed', 'canceled', 'interrupted', 'exhausted'] as const
export type TerminalNonDoneStatus = (typeof TERMINAL_NON_DONE)[number]

export function isTerminalNonDone(s: string): s is TerminalNonDoneStatus {
  return (TERMINAL_NON_DONE as readonly string[]).includes(s)
}
