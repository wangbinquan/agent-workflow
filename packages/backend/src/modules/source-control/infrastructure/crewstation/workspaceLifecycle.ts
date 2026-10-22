// RFC-370 §9.2 V3 — hosted parent lifecycle reconciler.
//
// A persistent CS parent holds a Pod and quota while it runs, and the platform's
// migration barrier requires parents to be paused. Source Control therefore
// pauses every parent whose volume is not in use and lets the next use resume
// it (`HostedTaskWorkspaces.ensure` / `open`). It also completes a close whose
// platform receipt was lost or that the platform refused for the moment
// (`closing` rows, including the parent of a launch that was never admitted)
// and records parents the platform already released.
//
// "In use" (any one keeps the parent running):
//   - task execution reports the owner active: an AW task bound to the volume
//     is pending/running, or an execution binding on it has not settled
//     (`HostedVolumeActivity`, implemented by task-execution);
//   - a workspace command on it has not settled (Source Control's journal);
//   - an in-process hold (`retainWorkspace`, e.g. a verification writer);
//   - it was used recently: every ensure/open refreshes `updatedAt`. AW task
//     owners get a short grace (the window between a ready check and the
//     submit it guards); shared owners (`system:…`, `development:shared`, …)
//     are paused only after an idle period, since their consecutive operations
//     are not covered by a task status.
// Only parents the platform reports `running` are paused. A scratch owner's
// parent created under another release (`HostedTaskWorkspaces.superseded`) is
// closed instead once idle, running or not, so its owner's next use gets a
// parent with the running release's task image. A durable shared owner's idle
// parent that is already paused is upgraded to the release's task image when
// it runs another one (§10 V21, CS RFC-043); its next use resumes it on it.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  BusinessStopAuthority,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { sha256Hex } from '@/util/hash'
import type { Logger } from '@/util/log'
import type { HostedVolumeActivity } from '../../public/participants'
import {
  hostedLifecycleRequestKey,
  isLifecycleRace,
  TERMINAL_SUBTASK_STATES,
  type HostedTaskWorkspaces,
} from './taskWorkspace'
import {
  NO_HOSTED_IMAGE_UPGRADES,
  type HostedWorkspaceImageUpgrades,
} from './workspaceImageUpgrade'
import { hostedWorkspaceOwnerKind } from './workspaceOwnership'

/** Short grace after the last use of an AW task's volume. */
export const HOSTED_TASK_VOLUME_GRACE_MS = 120_000
/** Idle period before a shared (non-task) volume is paused. */
export const HOSTED_SHARED_VOLUME_IDLE_MS = 600_000
/** Background pass period. */
export const HOSTED_WORKSPACE_LIFECYCLE_INTERVAL_MS = 60_000

export interface HostedWorkspaceLifecyclePass {
  readonly paused: readonly string[]
  readonly closed: readonly string[]
  readonly failed: readonly string[]
  /** Paused parents upgraded to the release's task image; only when any were. */
  readonly upgraded?: readonly string[]
}

export interface HostedWorkspaceLifecycle {
  pass(signal: AbortSignal): Promise<HostedWorkspaceLifecyclePass>
}

export function createHostedWorkspaceLifecycle(input: {
  readonly db: PersistenceDb
  readonly api: CrewStationBusinessExecution
  readonly fence: CrewStationMutationFence
  readonly workspaces: Pick<HostedTaskWorkspaces, 'close' | 'superseded'>
  readonly commands: { hasUnsettledCommands(businessTaskId: string): Promise<boolean> }
  readonly activity: HostedVolumeActivity
  /** In-process holds by volume owner. */
  readonly held: (owner: string) => boolean
  /** §10 V21: task-image upgrades of idle durable parents. */
  readonly imageUpgrades?: Pick<HostedWorkspaceImageUpgrades, 'due' | 'upgradePaused'>
  readonly taskGraceMs?: number
  readonly sharedIdleMs?: number
  readonly now?: () => number
  readonly log?: Pick<Logger, 'warn'>
}): HostedWorkspaceLifecycle {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const imageUpgrades = input.imageUpgrades ?? NO_HOSTED_IMAGE_UPGRADES
  const taskGraceMs = input.taskGraceMs ?? HOSTED_TASK_VOLUME_GRACE_MS
  const sharedIdleMs = input.sharedIdleMs ?? HOSTED_SHARED_VOLUME_IDLE_MS
  // A `closing` registration may have no parent receipt yet: an abandoned
  // launch whose create the platform is still admitting. It is retried too.
  const rows = () => {
    const { hostedTaskWorkspaces } = tablesOf(input.db)
    return input.db
      .select()
      .from(hostedTaskWorkspaces)
      .where(
        or(
          eq(hostedTaskWorkspaces.state, 'closing'),
          and(
            inArray(hostedTaskWorkspaces.state, ['creating', 'ready']),
            isNotNull(hostedTaskWorkspaces.businessTaskId),
          ),
        ),
      )
  }
  const lastUse = async (taskId: string) => {
    const { hostedTaskWorkspaces } = tablesOf(input.db)
    return (
      await input.db
        .select({ updatedAt: hostedTaskWorkspaces.updatedAt, state: hostedTaskWorkspaces.state })
        .from(hostedTaskWorkspaces)
        .where(eq(hostedTaskWorkspaces.taskId, taskId))
        .limit(1)
    )[0]
  }
  const idleFor = (owner: string) =>
    hostedWorkspaceOwnerKind(owner) === 'task' ? taskGraceMs : sharedIdleMs
  const recordClosed = async (taskId: string) => {
    const fence = input.fence.current()
    await session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, fence)
      const { hostedTaskWorkspaces } = tablesOf(tx)
      await tx
        .update(hostedTaskWorkspaces)
        .set({ state: 'closed', updatedAt: now() })
        .where(eq(hostedTaskWorkspaces.taskId, taskId))
    })
  }

  return {
    async pass(signal) {
      const paused: string[] = []
      const closed: string[] = []
      const failed: string[] = []
      const upgraded: string[] = []
      const outcome = (): HostedWorkspaceLifecyclePass => ({
        paused,
        closed,
        failed,
        ...(upgraded.length === 0 ? {} : { upgraded }),
      })
      const candidates = await rows()
      if (candidates.length === 0) return outcome()
      let active = await input.activity.activeVolumeOwners()
      for (const row of candidates) {
        if (signal.aborted) break
        const owner = row.taskId
        try {
          if (row.state === 'closing') {
            // A close whose platform receipt was lost converges here.
            if (await input.workspaces.close(owner)) closed.push(owner)
            continue
          }
          if (active.has(owner) || input.held(owner)) continue
          if (now() - row.updatedAt < idleFor(owner)) continue
          if (await input.commands.hasUnsettledCommands(row.businessTaskId!)) continue
          const task = await input.api.getTask(row.businessTaskId!)
          if (task.id !== row.businessTaskId) throw new Error('hosted-workspace-receipt-mismatch')
          if (task.state === 'closed' && task.resourceState === 'released') {
            // Released by the platform: the registration no longer names a volume.
            await recordClosed(owner)
            closed.push(owner)
            continue
          }
          const retire = await input.workspaces.superseded(owner)
          const upgrade = !retire && (await imageUpgrades.due(owner, task))
          if (task.state !== 'running' && !retire && !upgrade) continue
          // Re-check use right before the effect: a use that started during this
          // pass refreshed `updatedAt` or made the owner active meanwhile.
          active = await input.activity.activeVolumeOwners()
          const current = await lastUse(owner)
          if (
            active.has(owner) ||
            input.held(owner) ||
            current === undefined ||
            current.state === 'closing' ||
            current.state === 'closed' ||
            now() - current.updatedAt < idleFor(owner)
          )
            continue
          if (retire) {
            if (await input.workspaces.close(owner)) closed.push(owner)
            continue
          }
          if (upgrade) {
            if (await imageUpgrades.upgradePaused(row, task, signal)) upgraded.push(owner)
            continue
          }
          try {
            await input.api.pauseTask(task.id, {
              requestKey: hostedLifecycleRequestKey(row.requestKey, 'pause', task.generation),
              fence: input.fence.current(),
              expectedGeneration: task.generation,
            })
            paused.push(owner)
          } catch (error) {
            // A subtask the platform still counts as active, or another lifecycle
            // operation in flight: the next pass decides again.
            if (!isLifecycleRace(error)) throw error
          }
        } catch (error) {
          failed.push(owner)
          input.log?.warn('hosted workspace lifecycle step failed', {
            owner,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return outcome()
    },
  }
}

/** The background owner shape the hosted daemon runs while it holds execution
 * authority: one pass per interval until the signal aborts. */
export function hostedWorkspaceLifecycleOwner(
  lifecycle: HostedWorkspaceLifecycle,
  options: {
    readonly intervalMs?: number
    readonly log?: Pick<Logger, 'warn'>
  } = {},
) {
  const intervalMs = options.intervalMs ?? HOSTED_WORKSPACE_LIFECYCLE_INTERVAL_MS
  return {
    id: 'hosted-workspace-lifecycle',
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          await lifecycle.pass(signal)
        } catch (error) {
          options.log?.warn('hosted workspace lifecycle pass failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, intervalMs)
          function done(): void {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          signal.addEventListener('abort', done, { once: true })
        })
      }
    },
  }
}

const TERMINAL_SUBTASK = TERMINAL_SUBTASK_STATES

/** One drain pass; `remaining` counts the parents that still hold a container. */
export type HostedMigrationDrain = (
  stop: BusinessStopAuthority,
  signal: AbortSignal,
) => Promise<{ readonly remaining: number }>

/**
 * §9.2 V7 / CS RFC-027 — while the platform holds a migration or restore
 * freeze, its barrier only proves that this installation's writers stopped:
 * the release that acknowledged the freeze drains them itself. A parent's
 * active subtasks are cancelled, then the parent is paused (its volume kept),
 * both under the freeze's stop authority, since the lease fence is gone. A
 * frozen instance's database write window is closed, so nothing is recorded:
 * every call is keyed to the freeze and the parent's generation (or the
 * subtask's attempt) and the next pass simply repeats it. Parents that are
 * paused, closed or failed hold no running container and are left alone; an
 * active owner's next use resumes a paused parent (`HostedTaskWorkspaces`).
 */
export function createHostedMigrationDrain(input: {
  readonly db: PersistenceDb
  readonly api: Pick<
    CrewStationBusinessExecution,
    'getTask' | 'listSubtasks' | 'cancelSubtask' | 'pauseTask'
  >
  readonly log?: Pick<Logger, 'warn'>
}): HostedMigrationDrain {
  const key = (
    parentRequestKey: string,
    action: 'cancel' | 'pause',
    stop: BusinessStopAuthority,
    ...parts: readonly (string | number)[]
  ) => {
    const suffix = parts.map((part) => `:${part}`).join('')
    const value = `${parentRequestKey}:migration:${stop.operationId}:${action}${suffix}`
    return value.length <= 128 ? value : `aw-task-op:${sha256Hex(value)}`
  }
  return async (stop, signal) => {
    const { hostedTaskWorkspaces } = tablesOf(input.db)
    const rows = await input.db
      .select({
        taskId: hostedTaskWorkspaces.taskId,
        requestKey: hostedTaskWorkspaces.requestKey,
        businessTaskId: hostedTaskWorkspaces.businessTaskId,
      })
      .from(hostedTaskWorkspaces)
      .where(
        and(
          inArray(hostedTaskWorkspaces.state, ['creating', 'ready', 'closing']),
          isNotNull(hostedTaskWorkspaces.businessTaskId),
        ),
      )
    let remaining = 0
    for (const row of rows) {
      if (signal.aborted) break
      try {
        const task = await input.api.getTask(row.businessTaskId!)
        if (task.id !== row.businessTaskId) throw new Error('hosted-workspace-receipt-mismatch')
        if (task.state !== 'running' && task.state !== 'creating') continue
        remaining += 1
        // A container that is still starting is paused once it runs.
        if (task.state === 'creating') continue
        const active = (await input.api.listSubtasks(task.id)).filter(
          (subtask) => !TERMINAL_SUBTASK.has(subtask.state),
        )
        for (const subtask of active) {
          if (subtask.state === 'cancelling') continue
          try {
            await input.api.cancelSubtask(task.id, subtask.id, {
              requestKey: key(row.requestKey, 'cancel', stop, subtask.id, subtask.attempt),
              stopAuthority: stop,
              expectedAttempt: subtask.attempt,
            })
          } catch (error) {
            if (!isLifecycleRace(error)) throw error
          }
        }
        // The platform pauses a parent only once its subtasks have results.
        if (active.length > 0) continue
        await input.api.pauseTask(task.id, {
          requestKey: key(row.requestKey, 'pause', stop, task.generation),
          stopAuthority: stop,
          expectedGeneration: task.generation,
        })
      } catch (error) {
        if (isLifecycleRace(error)) continue
        input.log?.warn('hosted migration drain step failed', {
          owner: row.taskId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { remaining }
  }
}
