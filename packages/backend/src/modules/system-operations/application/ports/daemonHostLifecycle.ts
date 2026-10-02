import type { DaemonRuntimeInfo } from '../../domain/daemonRuntime'
import type { DaemonRuntimeQueries } from '../../public/queries'

export type DaemonReadiness = Readonly<Omit<DaemonRuntimeInfo, 'pid'>>

export interface DaemonHostControl {
  close(): void | Promise<void>
}

export interface DaemonHostShutdownCallbacks {
  readonly onShutdown: (reason: string) => void | Promise<void>
  /** Last-chance synchronous cleanup when the host is exiting unexpectedly. */
  readonly onExit: () => void
  readonly onFailure: (error: unknown) => void
}

/** Host readiness/control effects; neither a PID lock nor an execution grant. */
export interface DaemonHostLifecyclePort extends DaemonRuntimeQueries {
  publishReady(readiness: DaemonReadiness): void | Promise<void>
  withdrawReady(): void | Promise<void>
  subscribeShutdown(
    callbacks: DaemonHostShutdownCallbacks,
  ): DaemonHostControl | Promise<DaemonHostControl>
  announceReady(browserUrl: string): void | Promise<void>
  terminate(code: number): never | Promise<never>
}
