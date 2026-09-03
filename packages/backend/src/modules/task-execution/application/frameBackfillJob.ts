// RFC-354 T4 — the durable one-shot frame backfill (application layer).
//
// Runs once per database after migration 0223: for every task it rebuilds the
// containment tree from the frozen workflow snapshot, plans the frame of each
// legacy row (`planFrameBackfill`, pure) and writes `container_run_id` /
// `scope_path` back; clarify rounds then take the frame of their park row.
// Completion is recorded in `maintenance_state` so later boots skip it in one
// read; `aw doctor --backfill-containers` forces a re-run (the planner is
// idempotent — rows that already carry a frame are left alone).
//
// Provider-neutral: the store port hides SQLite / PostgreSQL.

import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { createExecutionScopeIndex } from '../domain/executionScope'
import {
  planFrameBackfill,
  type FrameBackfillRunRow,
  type FrameBackfillUpdate,
} from '../domain/frameBackfill'

export const FRAME_BACKFILL_MARKER_KEY = 'rfc354.frame-backfill.v1'

export interface FrameBackfillStore {
  readMarker(): Promise<string | null>
  writeMarker(value: string): Promise<void>
  /** Every task that owns at least one node_runs row. */
  listTaskIds(): Promise<readonly string[]>
  loadTask(
    taskId: string,
  ): Promise<{ workflowSnapshot: string | null; runs: readonly FrameBackfillRunRow[] } | null>
  applyRunFrames(updates: readonly FrameBackfillUpdate[]): Promise<void>
  /** clarify_rounds.container_run_id := the park row's frame; returns rows changed. */
  alignClarifyRounds(taskId: string): Promise<number>
}

export interface FrameBackfillReport {
  readonly skipped: boolean
  readonly tasks: number
  readonly rowsUpdated: number
  readonly roundsUpdated: number
  /** Tasks whose snapshot could not be parsed into a scope tree (left untouched). */
  readonly unreadableTasks: readonly string[]
  /** Nested rows with no generation row minted before them (left untouched). */
  readonly unresolvedRows: number
}

export function parseFrozenDefinition(snapshot: string | null): WorkflowDefinition | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(snapshot))
    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
  } catch {
    return null
  }
}

export async function runFrameBackfill(input: {
  readonly store: FrameBackfillStore
  /** Re-run even when the marker says it already completed. */
  readonly force?: boolean
  readonly now?: () => number
}): Promise<FrameBackfillReport> {
  const { store } = input
  if (input.force !== true && (await store.readMarker()) !== null) {
    return {
      skipped: true,
      tasks: 0,
      rowsUpdated: 0,
      roundsUpdated: 0,
      unreadableTasks: [],
      unresolvedRows: 0,
    }
  }
  let tasks = 0
  let rowsUpdated = 0
  let roundsUpdated = 0
  let unresolvedRows = 0
  const unreadableTasks: string[] = []
  for (const taskId of await store.listTaskIds()) {
    const task = await store.loadTask(taskId)
    if (task === null) continue
    tasks += 1
    const definition = parseFrozenDefinition(task.workflowSnapshot)
    let parentOf: ReadonlyMap<string, string> | null = null
    if (definition !== null) {
      try {
        parentOf = createExecutionScopeIndex(definition).parentOf
      } catch {
        parentOf = null
      }
    }
    if (parentOf === null) {
      unreadableTasks.push(taskId)
      continue
    }
    const plan = planFrameBackfill({ parentOf, rows: task.runs })
    unresolvedRows += plan.unresolved.length
    if (plan.updates.length > 0) {
      await store.applyRunFrames(plan.updates)
      rowsUpdated += plan.updates.length
    }
    roundsUpdated += await store.alignClarifyRounds(taskId)
  }
  await store.writeMarker(
    JSON.stringify({
      completedAt: (input.now ?? Date.now)(),
      tasks,
      rowsUpdated,
      roundsUpdated,
      unreadableTasks: unreadableTasks.length,
      unresolvedRows,
    }),
  )
  return { skipped: false, tasks, rowsUpdated, roundsUpdated, unreadableTasks, unresolvedRows }
}
