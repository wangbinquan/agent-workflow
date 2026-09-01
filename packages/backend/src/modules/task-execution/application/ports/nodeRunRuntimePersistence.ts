import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'

import type { RuntimeKind } from '@/services/runtime'
import type { RuntimeProfile } from '@/platform/runtime-registry/application/runtimeRegistryOperations'

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
  load(nodeRunId: string): Promise<FrozenNodeRunRuntimeRecord | null>
  findBySessionId(sessionId: string): Promise<FrozenNodeRunRuntimeRecord | null>
  freeze(input: {
    readonly nodeRunId: string
    readonly runtime: RuntimeKind
    readonly runtimeBinary: string | null
    readonly runtimeParamsJson: string
  }): Promise<void>
}
