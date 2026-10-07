import type { Config } from '@agent-workflow/shared'
import {
  PROVIDER_SESSION_CLOSE_ABORT_REASON,
  PROVIDER_SESSION_PAUSE_ABORT_REASON,
} from '@agent-workflow/shared'

import { createFileTaskBackgroundConfigurationQuery } from '../infrastructure/local/fileTaskBackgroundConfiguration'
import type { TaskBackgroundConfigurationQuery } from '../application/ports/taskBackgroundConfiguration'
import { findStalledRunningChildren, runHeartbeatKillOnce } from '@/services/autoKill'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { reconcileDeadRunningRuns } from '@/services/orphanReconcile'
import {
  runDueSchedulesOnce,
  SCHEDULE_MAX_IN_FLIGHT,
  SCHEDULE_TICK_MS,
} from '@/services/scheduledTaskScheduler'
import type {
  BuildScheduleLaunch,
  ScheduleAuthorityRuntime,
  ScheduledTaskOperations,
} from '@/services/scheduledTasks'
import { createLogger } from '@/util/log'
import { killStaleRunProcessTree } from '@/util/process'
import type { TaskExecutionModule } from '../composition'
import type { TaskAutoResumeCommand } from '../application/ports/taskAutoResumeCommand'
import type { TaskLifecycleAutoRepairCommand } from '../application/ports/taskLifecycleAutoRepairCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'

const log = createLogger('task-execution.provider-background')

interface RestartableLoop {
  pause(): Promise<void>
  resume(): void
  stop(): Promise<void>
  awaitIdle(): Promise<void>
}

export interface TaskExecutionProviderBackgroundStartDependencies {
  readonly configPath?: string
  readonly configuration?: TaskBackgroundConfigurationQuery
  readonly scheduled: Readonly<{
    readonly operations: ScheduledTaskOperations
    readonly identityAccess: ScheduleAuthorityRuntime
    readonly loadConfig?: () => Config | Promise<Config>
    readonly onAutoDisable?: (id: string) => void
  }>
}

export interface TaskExecutionProviderBackgroundControl {
  /** Bind and start every TaskExecution-owned provider-session loop exactly once. */
  start(dependencies: TaskExecutionProviderBackgroundStartDependencies): Promise<void>
  /** Reversible admission freeze; waits for loop work and runtime handles to drain. */
  pause(): Promise<void>
  /** Freeze new claims and loop dispatch without aborting the current runtime. */
  quiesceAuthorityLoss(): Promise<void>
  /** Re-arm the same provider-bound loops and execution module. */
  resume(): Promise<void>
  /** One-way terminal stop; drains loops before sealing the execution module. */
  stop(): Promise<void>
  /** Compatibility final-close face; equivalent to stop with an explicit reason. */
  close(reason: string): Promise<readonly string[]>
  awaitIdle(): Promise<void>
}

interface ProviderBackgroundRuntime {
  readonly module: TaskExecutionModule
  readonly lifecycleRepair: TaskLifecycleAutoRepairCommand
  readonly autoResume: TaskAutoResumeCommand
  readonly recovery: TaskRecoveryOperations
  readonly taskHasDriver: (taskId: string) => boolean
  readonly buildScheduleLaunch: BuildScheduleLaunch
  readonly reconcileObservationUsage?: () => Promise<number>
}

/**
 * Is a periodic sweep due right now?
 *
 * Split out because it is the whole reason the knob is hot-apply: the loop that
 * calls this wakes on a fixed supervisory tick (DAEMON_CADENCE.orphanReconcileSupervisory)
 * and decides HERE whether this wake-up owes a sweep.  Deriving the sleep from
 * the cadence instead — what the loop did between RFC-349 and this fix — means a
 * change to the knob is only observed after the PREVIOUS cadence elapses, and
 * with the knob off that was ten minutes: turning periodic reconciliation on
 * looked exactly like a knob that needs a daemon restart.
 *
 * `configuredMs <= 0` is the off position and yields no sweep at all — not a
 * sweep that reads rows and spares them.
 */
export function isPeriodicReconcileDue(input: {
  readonly configuredMs: number
  readonly lastReconcileAt: number
  readonly now: number
}): boolean {
  if (!Number.isFinite(input.configuredMs) || input.configuredMs <= 0) return false
  return input.now - input.lastReconcileAt >= input.configuredMs
}

function createRestartableLoop(input: {
  readonly name: string
  readonly delayMs: () => number
  readonly run: () => Promise<void>
  readonly canDispatch?: () => boolean
}): RestartableLoop {
  let state: 'running' | 'paused' | 'stopped' = 'running'
  let timer: ReturnType<typeof setTimeout> | null = null
  let active: Promise<void> | null = null

  const clear = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const arm = (): void => {
    if (state !== 'running' || timer !== null || active !== null) return
    const requested = input.delayMs()
    const delayMs = Number.isSafeInteger(requested) && requested > 0 ? requested : 60_000
    timer = setTimeout(() => {
      timer = null
      if (state !== 'running') return
      if (input.canDispatch?.() === false) {
        arm()
        return
      }
      const run = input
        .run()
        .catch((error) => {
          log.warn(`${input.name} tick failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          if (active === run) active = null
          arm()
        })
      active = run
    }, delayMs)
    timer.unref?.()
  }

  const awaitIdle = async (): Promise<void> => {
    while (active !== null) await active
  }

  arm()
  return Object.freeze({
    async pause() {
      if (state === 'stopped') return
      state = 'paused'
      clear()
      await awaitIdle()
    },
    resume() {
      if (state === 'stopped') throw new Error(`${input.name}-loop-stopped`)
      state = 'running'
      arm()
    },
    async stop() {
      state = 'stopped'
      clear()
      await awaitIdle()
    },
    awaitIdle,
  })
}

function createProviderLoops(
  runtime: ProviderBackgroundRuntime,
  dependencies: TaskExecutionProviderBackgroundStartDependencies,
  configuration: TaskBackgroundConfigurationQuery,
  canDispatch: () => boolean,
): readonly RestartableLoop[] {
  // A selected source supplies every loop. The scheduled-only legacy override
  // remains compatible when the caller has not selected a shared source.
  const scheduledConfig =
    dependencies.configuration === undefined && dependencies.scheduled.loadConfig !== undefined
      ? dependencies.scheduled.loadConfig
      : () => configuration.read()

  const autoRepair = createRestartableLoop({
    name: 'auto-repair',
    canDispatch,
    delayMs: () => DAEMON_CADENCE.autoRepair,
    async run() {
      const current = await configuration.read()
      if (!canDispatch()) return
      const enabled = current.autoRepair ?? {}
      if (!Object.values(enabled).some((value) => value === true)) return
      await runtime.lifecycleRepair.run({
        enabledRules: Object.entries(enabled)
          .filter(([, value]) => value === true)
          .map(([rule]) => rule),
        maxPerWindow: current.maxAutoRecoveriesPerWindow,
        windowMs: current.autoRecoveryWindowMs,
      })
    },
  })

  const heartbeatKill = createRestartableLoop({
    name: 'heartbeat-kill',
    canDispatch,
    delayMs: () => DAEMON_CADENCE.autoKill,
    async run() {
      const current = await configuration.read()
      if (!canDispatch()) return
      if (current.autoKillStalledChild !== true) return
      const occurredAt = Date.now()
      await runHeartbeatKillOnce({
        operations: runtime.recovery,
        enabled: true,
        breaker: {
          maxPerWindow: current.maxAutoRecoveriesPerWindow,
          windowMs: current.autoRecoveryWindowMs,
        },
        findStalledRuns: () =>
          findStalledRunningChildren(runtime.recovery, current.heartbeatStallMs, occurredAt),
        killChild: (run) =>
          killStaleRunProcessTree({
            pid: run.pid,
            startedAt: run.startedAt,
            spawnBinaryPath: run.spawnBinaryPath,
            spawnLaunchNonce: run.spawnLaunchNonce,
          }),
      })
    },
  })

  // The cadence knob is hot-apply, so the sleep must NOT be derived from it:
  // a loop that sleeps the configured cadence only observes a change after the
  // PREVIOUS one elapses, and switched off that was DAEMON_CADENCE.orphanReconcile
  // — ten minutes of "I turned it on and nothing happened", indistinguishable
  // from a knob that needs a daemon restart (the pre-RFC-349
  // `startOrphanReconcileLoop` re-armed from a config-applied listener instead).
  // Wake on a fixed supervisory tick and decide there whether a sweep is due.
  let lastReconcileAt = Date.now()
  const orphanReconcile = createRestartableLoop({
    name: 'orphan-reconcile',
    canDispatch,
    delayMs: () => DAEMON_CADENCE.orphanReconcileSupervisory,
    async run() {
      const now = Date.now()
      const due = isPeriodicReconcileDue({
        configuredMs: (await configuration.read()).periodicOrphanReconcileMs,
        lastReconcileAt,
        now,
      })
      if (!canDispatch()) return
      if (!due) return
      lastReconcileAt = now
      await reconcileDeadRunningRuns({
        operations: runtime.recovery,
        taskHasDriver: runtime.taskHasDriver,
        graceMs: 60_000,
      })
    },
  })

  const scheduled = createRestartableLoop({
    name: 'scheduled-task',
    canDispatch,
    delayMs: () => SCHEDULE_TICK_MS,
    async run() {
      const current = await scheduledConfig()
      if (!canDispatch()) return
      if (current.scheduledTasksEnabled === false) return
      await runDueSchedulesOnce(dependencies.scheduled.operations, {
        buildLaunch: runtime.buildScheduleLaunch,
        identityAccess: dependencies.scheduled.identityAccess,
        maxFailures: current.scheduledTasksMaxFailures,
        limit: SCHEDULE_MAX_IN_FLIGHT,
        defaultRuntime: current.defaultRuntime,
        ...(dependencies.scheduled.onAutoDisable === undefined
          ? {}
          : { onAutoDisable: dependencies.scheduled.onAutoDisable }),
      })
    },
  })

  const observations =
    runtime.reconcileObservationUsage === undefined
      ? []
      : [
          createRestartableLoop({
            name: 'observation-usage',
            canDispatch,
            delayMs: () => DAEMON_CADENCE.observationUsage,
            run: async () => {
              await runtime.reconcileObservationUsage!()
            },
          }),
        ]
  return Object.freeze([autoRepair, heartbeatKill, orphanReconcile, scheduled, ...observations])
}

/**
 * Provider-session control for runtime admission plus every TaskExecution-owned
 * periodic writer.  Pause is reversible; stop is the only sealing operation.
 */
export function composeTaskExecutionProviderBackground(
  runtime: ProviderBackgroundRuntime,
): TaskExecutionProviderBackgroundControl {
  let loops: readonly RestartableLoop[] = []
  let started = false
  let stopped = false
  let startupRun: Promise<void> | null = null
  let serialized: Promise<unknown> = Promise.resolve()
  let authorityQuiesced = false
  let authorityQuiesceVersion = 0

  async function drainTickets(
    tickets: Awaited<ReturnType<TaskExecutionModule['pause']>>,
  ): Promise<readonly string[]> {
    await Promise.all(tickets.map((ticket) => runtime.module.runtimeRegistry.awaitStopped(ticket)))
    return Object.freeze(tickets.map((ticket) => ticket.token.taskId))
  }

  const awaitLoopIdle = async (): Promise<void> => {
    await Promise.all(loops.map((loop) => loop.awaitIdle()))
    if (startupRun !== null) await startupRun
  }

  const queue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serialized.then(operation, operation)
    serialized = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  return Object.freeze({
    async start(dependencies: TaskExecutionProviderBackgroundStartDependencies) {
      if (authorityQuiesced) throw new Error('task-execution-provider-authority-quiesced')
      if (started) throw new Error('task-execution-provider-background-already-started')
      if (stopped) throw new Error('task-execution-provider-background-stopped')
      started = true
      const configuration =
        dependencies.configuration ??
        (dependencies.configPath === undefined
          ? undefined
          : createFileTaskBackgroundConfigurationQuery(dependencies.configPath))
      if (configuration === undefined) throw new Error('task-background-configuration-required')
      loops = createProviderLoops(runtime, dependencies, configuration, () => !authorityQuiesced)
      // Startup reads are part of the same drain boundary as auto-resume. Pause
      // and stop cannot overtake a pending selected configuration read.
      const currentRead = (async () => await configuration.read())()
      const run = currentRead
        .then(async (current) => {
          if (authorityQuiesced || !current.autoResumeOnBoot) return
          await runtime.autoResume
            .run({
              breaker: {
                maxPerWindow: current.maxAutoRecoveriesPerWindow,
                windowMs: current.autoRecoveryWindowMs,
              },
            })
            .then(() => undefined)
            .catch((error) => {
              log.warn('boot auto-resume failed', {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        })
        .catch(() => undefined)
        .finally(() => {
          if (startupRun === run) startupRun = null
        })
      startupRun = run
      // Startup must know the selected settings, but auto-resume keeps its
      // original detached behavior; the full run remains tracked for draining.
      // A read failure propagates here; the drain promise observes it as well.
      await currentRead
    },
    async pause() {
      await queue(async () => {
        await Promise.all(loops.map((loop) => loop.pause()))
        if (startupRun !== null) await startupRun
        await drainTickets(await runtime.module.pause(PROVIDER_SESSION_PAUSE_ABORT_REASON))
      })
    },
    async quiesceAuthorityLoss() {
      authorityQuiesced = true
      authorityQuiesceVersion++
      const claimDrain = runtime.module.quiesceAuthorityLoss()
      await queue(async () => {
        await Promise.all(loops.map((loop) => loop.pause()))
        if (startupRun !== null) await startupRun
        await claimDrain
      })
    },
    async resume() {
      const version = authorityQuiesceVersion
      await queue(async () => {
        if (stopped) throw new Error('task-execution-provider-background-stopped')
        if (version !== authorityQuiesceVersion) {
          throw new Error('task-execution-provider-authority-quiesced')
        }
        runtime.module.resume()
        authorityQuiesced = false
        for (const loop of loops) loop.resume()
      })
    },
    async stop() {
      await queue(async () => {
        if (stopped) return
        stopped = true
        await Promise.all(loops.map((loop) => loop.stop()))
        if (startupRun !== null) await startupRun
        await drainTickets(await runtime.module.dispose(PROVIDER_SESSION_CLOSE_ABORT_REASON))
      })
    },
    async close(reason: string) {
      return await queue(async () => {
        if (!stopped) {
          stopped = true
          await Promise.all(loops.map((loop) => loop.stop()))
          if (startupRun !== null) await startupRun
        }
        return await drainTickets(await runtime.module.dispose(reason))
      })
    },
    async awaitIdle() {
      await serialized
      await awaitLoopIdle()
      await runtime.module.awaitIdle()
    },
  })
}
