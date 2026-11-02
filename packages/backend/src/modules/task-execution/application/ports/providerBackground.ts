// RFC-418: ports of the provider-session background control (application/providerBackground.ts). Legacy sweeps,
// cadence constants, the file configuration source and the scheduled-task runner are bound by composition.
import type { Config } from '@agent-workflow/shared'
import type {
  TaskBackgroundConfiguration,
  TaskBackgroundConfigurationQuery,
} from './taskBackgroundConfiguration'
import type { TaskAutoResumeCommand } from './taskAutoResumeCommand'
import type { TaskLifecycleAutoRepairCommand } from './taskLifecycleAutoRepairCommand'

/** The execution module's admission freeze; its stop tickets stay opaque here. */
export interface ProviderBackgroundModule<
  TTicket extends { readonly token: { readonly taskId: string } },
> {
  pause(reason: string): Promise<readonly TTicket[]>
  resume(): void
  dispose(reason: string): Promise<readonly TTicket[]>
  awaitIdle(): Promise<void>
  readonly runtimeRegistry: { awaitStopped(ticket: TTicket): Promise<unknown> }
}

/** Read on every timer arm, exactly where the loops used to read the cadence constants. */
export interface ProviderBackgroundCadence {
  autoRepairMs(): number
  autoKillMs(): number
  orphanReconcileSupervisoryMs(): number
  scheduleTickMs(): number
}

/** The two legacy sweeps a due loop runs; whether a loop is on or due stays in the application. */
export interface ProviderBackgroundSweeps {
  heartbeatKill(input: {
    readonly breaker: {
      readonly maxPerWindow: TaskBackgroundConfiguration['maxAutoRecoveriesPerWindow']
      readonly windowMs: TaskBackgroundConfiguration['autoRecoveryWindowMs']
    }
    readonly heartbeatStallMs: TaskBackgroundConfiguration['heartbeatStallMs']
    readonly occurredAt: number
  }): Promise<void>
  orphanReconcile(): Promise<void>
}

export interface TaskExecutionProviderBackgroundPorts<
  TTicket extends { readonly token: { readonly taskId: string } },
> {
  readonly recoveryConsumer?: { tick(): Promise<void> }
  readonly module: ProviderBackgroundModule<TTicket>
  readonly lifecycleRepair: TaskLifecycleAutoRepairCommand
  readonly autoResume: TaskAutoResumeCommand
  readonly cadence: ProviderBackgroundCadence
  readonly fileConfiguration: (configPath: string) => TaskBackgroundConfigurationQuery
  readonly sweeps: ProviderBackgroundSweeps
}

/** Start-time inputs; the scheduled-task runner arrives already bound to its operations. */
export interface ProviderBackgroundStart {
  readonly configPath?: string
  readonly configuration?: TaskBackgroundConfigurationQuery
  readonly scheduled: {
    readonly loadConfig?: () => Config | Promise<Config>
    runDue(input: {
      readonly maxFailures: TaskBackgroundConfiguration['scheduledTasksMaxFailures']
      readonly defaultRuntime: TaskBackgroundConfiguration['defaultRuntime']
    }): Promise<void>
  }
}

export interface ProviderBackgroundControl {
  /** Bind and start every TaskExecution-owned provider-session loop exactly once. */
  start(dependencies: ProviderBackgroundStart): Promise<void>
  /** Reversible admission freeze; waits for loop work and runtime handles to drain. */
  pause(reason?: 'provider-switch' | 'daemon-shutdown'): Promise<void>
  /** Re-arm the same provider-bound loops and execution module. */
  resume(): Promise<void>
  /** One-way terminal stop; drains loops before sealing the execution module. */
  stop(): Promise<void>
  /** Compatibility final-close face; equivalent to stop with an explicit reason. */
  close(reason: string): Promise<readonly string[]>
  awaitIdle(): Promise<void>
}
