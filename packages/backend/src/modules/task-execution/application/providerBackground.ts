// RFC-418: provider-session background control, moved verbatim from composition/providerBackground.ts. The
// restartable loops, the five provider loops (their on / due judgements) and the serialized pause / resume / stop /
// close control are application flow; legacy sweeps, cadence constants, the file configuration source and the
// scheduled-task runner arrive through ports bound by composition.
import {
  DAEMON_SHUTDOWN_ABORT_REASON,
  PROVIDER_SESSION_CLOSE_ABORT_REASON,
  PROVIDER_SESSION_PAUSE_ABORT_REASON,
} from '@agent-workflow/shared'

import { createLogger } from '@/util/log'
import type { TaskBackgroundConfigurationQuery } from './ports/taskBackgroundConfiguration'
import type {
  ProviderBackgroundControl,
  ProviderBackgroundStart,
  TaskExecutionProviderBackgroundPorts,
} from './ports/providerBackground'

const log = createLogger('task-execution.provider-background')

interface RestartableLoop {
  pause(): Promise<void>
  resume(): void
  stop(): Promise<void>
  awaitIdle(): Promise<void>
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

function createProviderLoops<TTicket extends { readonly token: { readonly taskId: string } }>(
  runtime: TaskExecutionProviderBackgroundPorts<TTicket>,
  dependencies: ProviderBackgroundStart,
  configuration: TaskBackgroundConfigurationQuery,
): readonly RestartableLoop[] {
  // A selected source supplies every loop. The scheduled-only legacy override
  // remains compatible when the caller has not selected a shared source.
  const scheduledConfig =
    dependencies.configuration === undefined && dependencies.scheduled.loadConfig !== undefined
      ? dependencies.scheduled.loadConfig
      : () => configuration.read()

  const autoRepair = createRestartableLoop({
    name: 'auto-repair',
    delayMs: () => runtime.cadence.autoRepairMs(),
    async run() {
      const current = await configuration.read()
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
    delayMs: () => runtime.cadence.autoKillMs(),
    async run() {
      const current = await configuration.read()
      if (current.autoKillStalledChild !== true) return
      const occurredAt = Date.now()
      await runtime.sweeps.heartbeatKill({
        breaker: {
          maxPerWindow: current.maxAutoRecoveriesPerWindow,
          windowMs: current.autoRecoveryWindowMs,
        },
        heartbeatStallMs: current.heartbeatStallMs,
        occurredAt,
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
    delayMs: () => runtime.cadence.orphanReconcileSupervisoryMs(),
    async run() {
      const now = Date.now()
      const due = isPeriodicReconcileDue({
        configuredMs: (await configuration.read()).periodicOrphanReconcileMs,
        lastReconcileAt,
        now,
      })
      if (!due) return
      lastReconcileAt = now
      await runtime.sweeps.orphanReconcile()
    },
  })

  const scheduled = createRestartableLoop({
    name: 'scheduled-task',
    delayMs: () => runtime.cadence.scheduleTickMs(),
    async run() {
      const current = await scheduledConfig()
      if (current.scheduledTasksEnabled === false) return
      await dependencies.scheduled.runDue({
        maxFailures: current.scheduledTasksMaxFailures,
        defaultRuntime: current.defaultRuntime,
      })
    },
  })

  return Object.freeze([
    autoRepair,
    heartbeatKill,
    orphanReconcile,
    scheduled,
    ...(runtime.recoveryConsumer === undefined
      ? []
      : [
          createRestartableLoop({
            name: 'hosted-recovery',
            delayMs: () => 5000,
            run: () => runtime.recoveryConsumer!.tick(),
          }),
        ]),
  ])
}

/**
 * Provider-session control for runtime admission plus every TaskExecution-owned
 * periodic writer.  Pause is reversible; stop is the only sealing operation.
 */
export function createTaskExecutionProviderBackground<
  TTicket extends { readonly token: { readonly taskId: string } },
>(runtime: TaskExecutionProviderBackgroundPorts<TTicket>): ProviderBackgroundControl {
  let loops: readonly RestartableLoop[] = []
  let started = false
  let stopped = false
  let startupRun: Promise<void> | null = null
  let serialized: Promise<unknown> = Promise.resolve()

  async function drainTickets(tickets: readonly TTicket[]): Promise<readonly string[]> {
    await Promise.all(tickets.map((ticket) => runtime.module.runtimeRegistry.awaitStopped(ticket)))
    return Object.freeze(tickets.map((ticket) => ticket.token.taskId))
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
    async start(dependencies: ProviderBackgroundStart) {
      if (started) throw new Error('task-execution-provider-background-already-started')
      if (stopped) throw new Error('task-execution-provider-background-stopped')
      started = true
      const configuration =
        dependencies.configuration ??
        (dependencies.configPath === undefined
          ? undefined
          : runtime.fileConfiguration(dependencies.configPath))
      if (configuration === undefined) throw new Error('task-background-configuration-required')
      loops = createProviderLoops(runtime, dependencies, configuration)
      // Startup reads are part of the same drain boundary as auto-resume. Pause
      // and stop cannot overtake a pending selected configuration read.
      const currentRead = (async () => await configuration.read())()
      const run = currentRead
        .then(async (current) => {
          if (!current.autoResumeOnBoot) return
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
    async pause(reason?: 'provider-switch' | 'daemon-shutdown') {
      // Signal drivers before waiting for loops that may themselves await them.
      const tickets =
        reason === 'daemon-shutdown'
          ? runtime.module.pause(DAEMON_SHUTDOWN_ABORT_REASON)
          : undefined
      await queue(async () => {
        await Promise.all(loops.map((loop) => loop.pause()))
        if (startupRun !== null) await startupRun
        await drainTickets(
          await (tickets ?? runtime.module.pause(PROVIDER_SESSION_PAUSE_ABORT_REASON)),
        )
      })
    },
    async resume() {
      await queue(async () => {
        if (stopped) throw new Error('task-execution-provider-background-stopped')
        runtime.module.resume()
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
      await Promise.all(loops.map((loop) => loop.awaitIdle()))
      if (startupRun !== null) await startupRun
      await runtime.module.awaitIdle()
    },
  })
}
