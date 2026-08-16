// RFC-304 §2.2 不变量一 — preemption, and the half of it that was never built.
//
// The transition table has said this since PR-1a: a new event on a RUNNING work
// item does NOT open a round. It moves the item to `superseding`, bumps the
// epoch, and asks for two effects — `request-round-cancel` now, `start-round`
// later, once the old task is genuinely terminal. The design is explicit about
// why the wait exists (§2.2): a round that is mid-publish races the cancel, and
// starting the replacement immediately gives one merge request two live rounds
// writing the same worktree.
//
// Nothing performed either effect. `superseding` was a state the machine could
// enter and never leave: no caller cancelled anything, nothing emitted
// `round-task-terminal`, and no code path anywhere referenced `start-round`. In
// production the wake path simply opened a round regardless — so three pushes
// in a row produced three concurrent rounds, each reviewing a revision the next
// had already replaced, and each posting its own comments.
//
// ## What this module is
//
// The effect performers, in one place, plus the two ways the "later" half can
// be reached:
//
//   1. in-process — the delivery that requested the cancel arms a terminal
//      watch on the old task and advances the item when it fires;
//   2. on boot — a sweep, because (1) lives in a process that can be restarted
//      between the cancel and the death, and an item stuck in `superseding`
//      is silent: no round, no error, and the merge request simply stops
//      getting reviews.
//
// Both funnel into `advanceSupersedingWorkItem`, which is idempotent: it emits
// `round-task-terminal` and starts a round only if the TABLE answers with
// `start-round`. Two callers racing produce one round, because the second one's
// event is rejected by a machine that has already left `superseding`.

import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeWorkItems, codeWorkRounds } from '@/db/schema'
import { noteWorkItemEvent } from '@/modules/code-capability/application/workItemProgress'
import {
  attachRoundTask,
  closeRound,
  openRound,
} from '@/modules/code-capability/infrastructure/sqliteMonitorStore'
import { readWorkItem } from '@/modules/code-capability/infrastructure/sqliteWorkItemStore'
import { startCodeRoundTask } from '@/services/codeRoundLaunch'
import { cancelTask } from '@/services/task'
import type { StartTaskDeps } from '@/services/task'
import { watchTaskTerminal } from '@/services/execution/executionWatch'
import { isTerminalTaskStatus } from '@/services/lifecycle'
import { tasks } from '@/db/schema'
import { createLogger } from '@/util/log'
import type { TriggerContext } from '@agent-workflow/shared'

const log = createLogger('code-supersede')

/**
 * What a deferred round needs to launch. Persisted in the work item's
 * `pendingRevision` when the table registers one, because the process that
 * receives the delivery is not necessarily the one that starts the round.
 */
export interface PendingRevisionPayload {
  capability: string
  repoId: string
  mrIid?: string | undefined
  triggerContext: TriggerContext
  webhookTriggerId: string
  webhookFireId: string
  baselineSha?: string | undefined
}

export interface SupersedeDeps {
  db: DbClient
  /** Built the same way the webhook dispatcher builds it. */
  launchDeps: StartTaskDeps & { db: DbClient }
}

/** The round of this item that has not ended, if any. */
async function liveRoundOf(
  db: DbClient,
  workItemId: string,
): Promise<{ roundId: string; taskId: string | null } | null> {
  const [row] = await db
    .select({ roundId: codeWorkRounds.id, taskId: codeWorkRounds.taskId })
    .from(codeWorkRounds)
    .where(and(eq(codeWorkRounds.workItemId, workItemId), isNull(codeWorkRounds.endedAt)))
    .orderBy(codeWorkRounds.roundSeq)
    .limit(1)
  return row === undefined ? null : { roundId: row.roundId, taskId: row.taskId }
}

/**
 * The task running a round, waiting out the gap in which it has none yet.
 *
 * A round is opened, then its task is created, then the id is written back —
 * three steps, so there is a window of a few tens of milliseconds in which the
 * round row exists with `task_id` still null. Treating that window as "no task
 * to wait for" is not a theoretical race: an event arriving inside it made the
 * preemption advance immediately and start the replacement round BESIDE the
 * one it was supposed to be replacing, which is the exact thing §2.2 forbids.
 *
 * Both columns are consulted because the task carries the round id from the
 * moment it is created, which is earlier than the write-back — so the window
 * that remains is only between opening the round and inserting the task.
 */
async function taskOfRound(
  db: DbClient,
  round: { roundId: string; taskId: string | null },
  waitMs = 5_000,
): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (round.taskId != null && round.taskId !== '') return round.taskId
    const [byRound] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.codeRoundId, round.roundId))
      .limit(1)
    if (byRound !== undefined) return byRound.id
    const [refreshed] = await db
      .select({ taskId: codeWorkRounds.taskId, endedAt: codeWorkRounds.endedAt })
      .from(codeWorkRounds)
      .where(eq(codeWorkRounds.id, round.roundId))
      .limit(1)
    if (refreshed?.taskId != null && refreshed.taskId !== '') return refreshed.taskId
    // The round ended without ever getting a task — nothing to wait for.
    if (refreshed?.endedAt != null) return null
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function parsePayload(raw: string | null): PendingRevisionPayload | null {
  if (raw === null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<PendingRevisionPayload>
    // A revision registered before this payload existed carries only `{at}`.
    // Treated as "nothing to launch" rather than as a launch with holes: a
    // round started against a missing trigger context would fail at
    // `resolve-target` and look like the capability is broken.
    if (typeof candidate.capability !== 'string' || candidate.capability === '') return null
    if (typeof candidate.repoId !== 'string' || candidate.repoId === '') return null
    if (typeof candidate.triggerContext !== 'object' || candidate.triggerContext === null) {
      return null
    }
    return candidate as PendingRevisionPayload
  } catch {
    return null
  }
}

/**
 * Perform `request-round-cancel`, then arrange for the replacement round.
 *
 * Called by whoever applied the event that produced the effect. Never throws:
 * a cancel that cannot be delivered must not fail the delivery that asked for
 * it — the boot sweep picks the item up either way.
 */
export async function requestRoundCancelAndArm(
  deps: SupersedeDeps,
  workItemId: string,
): Promise<void> {
  const live = await liveRoundOf(deps.db, workItemId)
  const taskId = live === null ? null : await taskOfRound(deps.db, live)
  if (taskId === null) {
    // Nothing to wait for — the round never got a task, so the item can move on
    // immediately rather than waiting for a death that cannot happen.
    await advanceSupersedingWorkItem(deps, workItemId)
    return
  }

  try {
    await cancelTask(deps.db, taskId)
  } catch (err) {
    // Already terminal, or already cancelled: both mean the wait below settles
    // immediately, which is the outcome we wanted anyway.
    log.debug?.('cancel request for a superseded round did not apply', {
      workItemId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  armTerminalAdvance(deps, workItemId, taskId)
}

/**
 * Advance when the old task dies. Deliberately NOT awaited by the caller: the
 * delivery is answered as soon as the cancel is requested, and the replacement
 * round starts on its own schedule.
 */
function armTerminalAdvance(deps: SupersedeDeps, workItemId: string, taskId: string): void {
  void watchTaskTerminal(deps.db, taskId)
    .then(async (result) => {
      if (result.kind === 'aborted') return
      await advanceSupersedingWorkItem(deps, workItemId)
    })
    .catch((err: unknown) => {
      log.warn('waiting for a superseded round to end failed', {
        workItemId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * Emit `round-task-terminal` and, if the table asks for it, start the round the
 * supersede was waiting to start.
 *
 * Idempotent by the machine: the event only decides anything while the item is
 * `superseding`, so a second caller gets a `stayed` with no `start-round` and
 * does nothing.
 */
export async function advanceSupersedingWorkItem(
  deps: SupersedeDeps,
  workItemId: string,
): Promise<{ started: boolean; reason: string }> {
  const item = await readWorkItem(deps.db, workItemId)
  if (item === null) return { started: false, reason: 'no such work item' }
  if (item.status !== 'superseding') {
    return { started: false, reason: `item is '${item.status}', not superseding` }
  }

  // The one fact this transition asserts: the preempted round is REALLY gone.
  // Checked here rather than trusted from the caller so that any caller is safe
  // — the in-process watch, the boot sweep, and the next delivery to arrive all
  // funnel through this, and a premature advance would start the replacement
  // beside a round that is still writing the same worktree.
  const live = await liveRoundOf(deps.db, workItemId)
  const runningTaskId = live === null ? null : await taskOfRound(deps.db, live, 0)
  if (runningTaskId !== null) {
    const [row] = await deps.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, runningTaskId))
      .limit(1)
    if (row !== undefined && !isTerminalTaskStatus(row.status)) {
      return { started: false, reason: `the preempted round is still '${row.status}'` }
    }
  }

  // Close the round the preemption killed. `finalizeRound` only runs when the
  // RUNNER returns — a task cancelled out from under a running node never
  // reaches it, so the row kept `ended_at` null forever. That is not only a
  // wrong ledger: `hasLiveRound` reads exactly this column, so a phantom live
  // round makes every later delivery believe a round is still running and
  // preempt a round that ended days ago.
  //
  // `superseded`, not `canceled`: nobody asked for this round to stop, a newer
  // revision simply replaced it, and the two read very differently to whoever
  // is looking for why their review never arrived. Idempotent by the
  // `ended_at IS NULL` guard inside `closeRound`.
  if (live !== null) await closeRound(deps.db, live.roundId, 'superseded')

  const payload = parsePayload(item.pendingRevision)

  const outcome = await noteWorkItemEvent({
    db: deps.db,
    workItemId,
    // The whole point of this call: the old task is gone, which is the ONE
    // fact `superseding` is waiting on.
    hasLiveRound: false,
    event: { kind: 'round-task-terminal' },
  })

  const effects =
    outcome.outcome === 'applied' || outcome.outcome === 'stayed' ? outcome.effects : []
  if (!effects.some((effect) => effect.kind === 'start-round')) {
    return { started: false, reason: `the machine did not ask for a round (${outcome.outcome})` }
  }

  if (payload === null) {
    // The machine says start one and the platform cannot: loud, because the
    // merge request is now waiting for a round that will never come.
    log.warn('a superseded work item has no launchable revision recorded', { workItemId })
    return { started: false, reason: 'the pending revision recorded nothing to launch' }
  }

  // Read AFTER the transition so the round carries the epoch the supersede
  // bumped — the value every stale-output check compares against.
  const advanced = await readWorkItem(deps.db, workItemId)
  const round = await openRound({
    db: deps.db,
    workItemId,
    epoch: advanced?.epoch ?? item.epoch,
    ...(payload.baselineSha === undefined ? {} : { baselineSha: payload.baselineSha }),
  })

  const task = await startCodeRoundTask(
    {
      roundId: round.roundId,
      capability: payload.capability,
      roundSeq: round.roundSeq,
      name: `${payload.capability} · MR ${payload.mrIid ?? '?'}`,
      cachedRepoId: payload.repoId,
    },
    {
      ...deps.launchDeps,
      launchProvenance: { kind: 'webhook' },
      webhookTriggerId: payload.webhookTriggerId,
      webhookFireId: payload.webhookFireId,
      triggerContext: payload.triggerContext,
    } as StartTaskDeps & { db: DbClient },
  )
  await attachRoundTask(deps.db, round.roundId, task.id)

  // The take that turns the queued item into a running one, mirroring the
  // ordinary wake path.
  await noteWorkItemEvent({
    db: deps.db,
    workItemId,
    hasLiveRound: true,
    event: { kind: 'scheduler-take' },
  })

  log.info('a superseded work item started its replacement round', {
    workItemId,
    roundId: round.roundId,
    roundSeq: round.roundSeq,
    taskId: task.id,
  })
  return { started: true, reason: 'started' }
}

/**
 * Boot sweep — every item left mid-preemption by a restart.
 *
 * Without it, a daemon that dies between "cancel requested" and "old task
 * terminal" leaves the item in `superseding` for good. That failure is
 * completely silent from the outside: the merge request just stops being
 * reviewed, and the platform reports no error because, as far as it knows,
 * nothing is wrong.
 */
export async function resumeSupersedingWorkItems(deps: SupersedeDeps): Promise<number> {
  const stuck = await deps.db
    .select({ id: codeWorkItems.id })
    .from(codeWorkItems)
    .where(eq(codeWorkItems.status, 'superseding'))

  let resumed = 0
  for (const item of stuck) {
    const live = await liveRoundOf(deps.db, item.id)
    // No wait here: at boot the round either has a task or never will, and
    // holding the sweep for five seconds per item would delay startup.
    const taskId = live === null ? null : await taskOfRound(deps.db, live, 0)
    if (taskId !== null) {
      const [row] = await deps.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      // Still running after a restart: the reaper will settle it, so wait for
      // that rather than starting a second round beside it.
      if (row !== undefined && !isTerminalTaskStatus(row.status)) {
        armTerminalAdvance(deps, item.id, taskId)
        continue
      }
    }
    const advanced = await advanceSupersedingWorkItem(deps, item.id)
    if (advanced.started) resumed += 1
  }
  if (stuck.length > 0) {
    log.info('resumed work items left mid-preemption by a restart', {
      found: stuck.length,
      started: resumed,
    })
  }
  return resumed
}
