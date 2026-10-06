import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'

export interface DaemonExecutionRuntimeScope {
  readonly operationId: string
  readonly provider: DatabaseProvider
  readonly generationId: string
}

export interface DaemonExecutionRuntimeState {
  /** Requested background execution intent, retained across provider pauses. */
  readonly enabled: boolean
  /** True only after the complete handle set has started on a running provider. */
  readonly running: boolean
  readonly activeHandleIds: readonly string[]
}

/** Background execution only; resource HTTP/WS delegates remain available. */
export interface DaemonExecutionRuntimeControl {
  pause(scope: DaemonExecutionRuntimeScope): Promise<void>
  resume(scope: DaemonExecutionRuntimeScope): Promise<void>
  state(): DaemonExecutionRuntimeState
}
