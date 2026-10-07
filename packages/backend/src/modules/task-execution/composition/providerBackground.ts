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
import type {
  TaskProviderAuthorityRuntime,
  TaskProviderExecutionAuthority,
} from '../application/ports/taskProviderAuthorityRuntime'

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
  /** Bind an independent handle to one selected authority generation. */
  startAuthority(
    dependencies: TaskExecutionProviderBackgroundStartDependencies,
    authority: TaskProviderExecutionAuthority,
  ): Promise<TaskProviderAuthorityRuntime>
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

interface TaskProviderAuthorityLifetime {
  readonly handle: TaskProviderAuthorityRuntime
  readonly close: (reason: string) => Promise<readonly string[]>
  readonly awaitIdle: () => Promise<void>
  readonly isDrained: () => boolean
}

type TaskProviderAuthoritySelection =
  | { readonly kind: 'unselected' }
  | { readonly kind: 'selected'; readonly lifetime: TaskProviderAuthorityLifetime }

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
  let mode: 'native' | 'selected' | undefined
  let authoritySelection: TaskProviderAuthoritySelection = { kind: 'unselected' }
  let selectedBootResumePending = true

  const ownsLifetime = (lifetime: TaskProviderAuthorityLifetime): boolean =>
    authoritySelection.kind === 'selected' && authoritySelection.lifetime === lifetime

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

  const startAuthority = async (
    dependencies: TaskExecutionProviderBackgroundStartDependencies,
    authority: TaskProviderExecutionAuthority,
  ): Promise<TaskProviderAuthorityRuntime> => {
    const capturedCurrent = authority?.current
    if (typeof capturedCurrent !== 'function') {
      throw new Error('task-provider-execution-authority-required')
    }
    const current = (): boolean => capturedCurrent.call(authority) === true
    if (!current()) throw new Error('task-provider-execution-authority-not-current')
    if (mode === 'native') throw new Error('task-provider-execution-authority-mode-mismatch')
    if (stopped) throw new Error('task-execution-provider-background-stopped')
    if (authoritySelection.kind === 'selected' && !authoritySelection.lifetime.isDrained()) {
      throw new Error('task-provider-execution-authority-drain-pending')
    }
    const configuration =
      dependencies.configuration ??
      (dependencies.configPath === undefined
        ? undefined
        : createFileTaskBackgroundConfigurationQuery(dependencies.configPath))
    if (configuration === undefined) throw new Error('task-background-configuration-required')

    // This old-work ACK loop belongs to the selected Task lifetime, separately
    // from dispatch loops; loss/pause cannot stop actual cleanup retries.
    const finalizations = runtime.module.host?.finalizations
    const retryFinalizations = finalizations?.retryPending
    const drainFinalizations = finalizations?.drain
    const finalizationLoop =
      finalizations === undefined
        ? undefined
        : createRestartableLoop({
            name: 'task-driver-finalization',
            delayMs: () => 1_000,
            run: () => retryFinalizations!.call(finalizations),
          })

    let retired = false
    let drained = false
    let ownedLoops: readonly RestartableLoop[] = []
    let ownedStartup: Promise<void> | null = null
    let normalPause: Promise<void> | null = null
    let lossQuiesce: Promise<void> | null = null
    let terminalClose: Promise<readonly string[]> | null = null
    let normalRequested = false
    let normalAcknowledged = false
    let lossRequested = false
    let lossAcknowledged = false
    let closeRequested = false
    let closeAcknowledged = false
    let lossClaims: Promise<void> | null = null
    let normalTickets: Awaited<ReturnType<TaskExecutionModule['pause']>> | null = null
    let closeTickets: Awaited<ReturnType<TaskExecutionModule['dispose']>> | null = null
    let closeReason: string | undefined
    const canDispatch = (): boolean => ownsLifetime(lifetime) && !retired && !stopped && current()
    const pauseLoops = (): Promise<void[]> => Promise.all(ownedLoops.map((loop) => loop.pause()))
    const waitOwnedWork = async (): Promise<void> => {
      await Promise.all(ownedLoops.map((loop) => loop.awaitIdle()))
      if (ownedStartup !== null) await ownedStartup
    }
    const gateDrain = (): Promise<void> => {
      const pending = ownsLifetime(lifetime)
        ? runtime.module.quiesceAuthorityLoss()
        : Promise.resolve()
      // This ACK may reject while a startup read still occupies the owner.
      // Preserve the rejection for its awaited caller without an unhandled gap.
      void pending.catch(() => undefined)
      return pending
    }

    const quiesceAuthorityLoss = (): Promise<void> => {
      retired = true
      lossRequested = true
      if (lossQuiesce !== null) return lossQuiesce
      if (lossClaims === null) {
        const pending = gateDrain()
        lossClaims = pending
        void pending.catch(() => {
          if (lossClaims === pending) lossClaims = null
        })
      }
      const claims = lossClaims
      const loops = pauseLoops()
      const attempt = (async () => {
        await loops
        await waitOwnedWork()
        await claims
        lossAcknowledged = true
      })()
      lossQuiesce = attempt
      void attempt.catch(() => {
        if (lossQuiesce === attempt) lossQuiesce = null
      })
      return attempt
    }
    const pause = (): Promise<void> => {
      retired = true
      normalRequested = true
      if (normalPause !== null) return normalPause
      const cancelNormally = !lossRequested && ownsLifetime(lifetime)
      const claims = gateDrain()
      const loops = pauseLoops()
      const attempt = queue(async () => {
        await loops
        await waitOwnedWork()
        await claims
        if (normalTickets === null && cancelNormally && ownsLifetime(lifetime)) {
          normalTickets = await runtime.module.pause(PROVIDER_SESSION_PAUSE_ABORT_REASON)
        }
        if (normalTickets !== null) await drainTickets(normalTickets)
        normalAcknowledged = true
      })
      normalPause = attempt
      void attempt.catch(() => {
        if (normalPause === attempt) normalPause = null
      })
      return attempt
    }
    const close = (reason: string): Promise<readonly string[]> => {
      retired = true
      closeRequested = true
      if (terminalClose !== null) return terminalClose
      closeReason ??= reason
      const claims = gateDrain()
      const loops = pauseLoops()
      const attempt = queue(async () => {
        await loops
        await waitOwnedWork()
        await claims
        if (!ownsLifetime(lifetime)) {
          closeAcknowledged = true
          return Object.freeze([])
        }
        closeTickets ??= await runtime.module.dispose(closeReason!)
        const ids = await drainTickets(closeTickets)
        closeAcknowledged = true
        return ids
      })
      terminalClose = attempt
      void attempt.catch(() => {
        if (terminalClose === attempt) terminalClose = null
      })
      return attempt
    }
    const drain = async (): Promise<void> => {
      if (!retired) throw new Error('task-provider-execution-authority-not-quiesced')
      for (;;) {
        const normal = normalPause,
          loss = lossQuiesce,
          closing = terminalClose
        await Promise.all([normal, loss, closing])
        await waitOwnedWork()
        if (lossRequested && !lossAcknowledged) {
          throw new Error('task-provider-execution-authority-loss-ack-pending')
        }
        if (closeRequested && !closeAcknowledged) {
          throw new Error('task-provider-execution-authority-close-ack-pending')
        }
        if (normalRequested && !normalAcknowledged) {
          if (!lossRequested) throw new Error('task-provider-execution-authority-pause-ack-pending')
          // A loss drain may retry receipt intake for an already-issued normal
          // stop. It never issues a fresh cancellation after authority loss.
          if (normalTickets !== null) await drainTickets(normalTickets)
        }
        if (normal === normalPause && loss === lossQuiesce && closing === terminalClose) {
          if (finalizations !== undefined) await drainFinalizations!.call(finalizations)
          await finalizationLoop?.stop()
          drained = true
          return
        }
      }
    }
    const handle = Object.freeze({ pause, quiesceAuthorityLoss, drain })
    const lifetime: TaskProviderAuthorityLifetime = Object.freeze({
      handle,
      close,
      awaitIdle: async () => {
        await waitOwnedWork()
        await finalizationLoop?.awaitIdle()
      },
      isDrained: () => drained,
    })
    mode = 'selected'
    authoritySelection = { kind: 'selected', lifetime }
    try {
      const claims = gateDrain()
      await claims
      if (!canDispatch()) return handle

      ownedLoops = createProviderLoops(runtime, dependencies, configuration, canDispatch)
      const currentRead = (async () => await configuration.read())()
      const moduleOpen = currentRead.then((settings) => {
        if (!canDispatch()) return undefined
        runtime.module.resume()
        return settings
      })
      const run = moduleOpen
        .then(async (settings) => {
          if (settings === undefined || !canDispatch()) return
          if (!selectedBootResumePending || !settings.autoResumeOnBoot) return
          selectedBootResumePending = false
          await runtime.autoResume
            .run({
              breaker: {
                maxPerWindow: settings.maxAutoRecoveriesPerWindow,
                windowMs: settings.autoRecoveryWindowMs,
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
          if (ownedStartup === run) ownedStartup = null
        })
      ownedStartup = run
      await moduleOpen
      return handle
    } catch (error) {
      await quiesceAuthorityLoss()
      await drain()
      throw error
    }
  }

  return Object.freeze({
    startAuthority,
    async start(dependencies: TaskExecutionProviderBackgroundStartDependencies) {
      if (mode === 'selected') throw new Error('task-provider-execution-authority-mode-mismatch')
      mode = 'native'
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
      if (mode === 'selected') {
        const selected = authoritySelection
        if (selected.kind === 'selected') {
          await selected.lifetime.handle.pause()
          await selected.lifetime.handle.drain()
        }
        return
      }
      await queue(async () => {
        await Promise.all(loops.map((loop) => loop.pause()))
        if (startupRun !== null) await startupRun
        await drainTickets(await runtime.module.pause(PROVIDER_SESSION_PAUSE_ABORT_REASON))
      })
    },
    async quiesceAuthorityLoss() {
      if (mode === 'selected') {
        const selected = authoritySelection
        if (selected.kind === 'selected') {
          await selected.lifetime.handle.quiesceAuthorityLoss()
          await selected.lifetime.handle.drain()
        }
        return
      }
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
      if (mode === 'selected') throw new Error('task-provider-execution-authority-required')
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
      if (mode === 'selected') {
        stopped = true
        const selected = authoritySelection
        if (selected.kind === 'selected') {
          await selected.lifetime.close(PROVIDER_SESSION_CLOSE_ABORT_REASON)
          await selected.lifetime.handle.drain()
        }
        return
      }
      await queue(async () => {
        if (stopped) return
        stopped = true
        await Promise.all(loops.map((loop) => loop.stop()))
        if (startupRun !== null) await startupRun
        await drainTickets(await runtime.module.dispose(PROVIDER_SESSION_CLOSE_ABORT_REASON))
      })
    },
    async close(reason: string) {
      if (mode === 'selected') {
        stopped = true
        const selected = authoritySelection
        if (selected.kind === 'unselected') return Object.freeze([])
        const ids = await selected.lifetime.close(reason)
        await selected.lifetime.handle.drain()
        return ids
      }
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
      if (mode === 'selected') {
        await serialized
        const selected = authoritySelection
        if (selected.kind === 'selected') await selected.lifetime.awaitIdle()
        await runtime.module.awaitIdle()
        return
      }
      await serialized
      await awaitLoopIdle()
      await runtime.module.awaitIdle()
    },
  })
}
