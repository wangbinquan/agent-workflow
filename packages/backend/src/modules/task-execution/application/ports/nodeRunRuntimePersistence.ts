import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'

import type { RuntimeKind, RuntimeProfile } from '@/modules/runtime-management/public/types'

export interface FrozenNodeRunRuntimeRecord {
  readonly runtime: string | null
  readonly runtimeBinary: string | null
  readonly runtimeParamsJson: string | null
}

export interface FrozenNodeRunRuntime {
  readonly protocol: RuntimeKind
  readonly binary: string | null
  readonly params: RuntimeProfile
  readonly configDir: RuntimeConfigDirProfile
}

/** Provider-neutral read/freeze boundary for a node run's immutable runtime. */
export interface NodeRunRuntimePersistence {
  withSelection<T>(
    nodeRunId: string,
    body: (session: NodeRunRuntimeSelectionSession) => Promise<T>,
  ): Promise<T>
  load(nodeRunId: string): Promise<FrozenNodeRunRuntimeRecord | null>
  findBySessionId(sessionId: string): Promise<FrozenNodeRunRuntimeRecord | null>
  freeze(input: {
    readonly nodeRunId: string
    readonly runtime: RuntimeKind
    readonly runtimeBinary: string | null
    readonly runtimeParamsJson: string
  }): Promise<void>
}

/** Task required port. The implementation owns the transaction, NodeRun and ownership fence. */
export interface NodeRunRuntimeSelectionSession {
  load(): Promise<FrozenNodeRunRuntimeRecord | null>
  select(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<FrozenNodeRunRuntime>
  freeze(input: Parameters<NodeRunRuntimePersistence['freeze']>[0]): Promise<void>
}
