import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { RuntimeKind, RuntimeObservationIdentity, RuntimeProfile } from '../../public/types'

// RFC-468: the persistence the task runtime freeze (`infrastructure/local/frozenTaskRuntime.ts`) needs from the
// node run's owner. Runtime Management owns this port because it is the caller (RFC-465's rule: the consumer owns
// the port, the implementer depends on the consumer); Task Execution's NodeRun runtime persistence satisfies it
// structurally and is handed in by composition. It stays internal: the fenced selection session is a callback,
// which a public contract does not carry.

/** The frozen runtime columns of a node run, as the freeze reads them back. */
export interface FrozenTaskRuntimeRecord {
  readonly runtime: string | null
  readonly runtimeBinary: string | null
  readonly runtimeParamsJson: string | null
}

/** A runtime freshly selected for a node run's first dispatch. */
export interface SelectedTaskRuntime {
  readonly protocol: RuntimeKind
  readonly binary: string | null
  readonly params: RuntimeProfile
  readonly configDir: RuntimeConfigDirProfile
  readonly observationIdentity?: RuntimeObservationIdentity
}

/** One fenced selection session on a node run (the implementation owns the transaction and ownership fence). */
export interface TaskRuntimeFreezeSession {
  load(): Promise<FrozenTaskRuntimeRecord | null>
  select(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<SelectedTaskRuntime>
  freeze(input: {
    readonly nodeRunId: string
    readonly runtime: RuntimeKind
    readonly runtimeBinary: string | null
    readonly runtimeParamsJson: string
  }): Promise<void>
}

/** What the freeze needs: one fenced selection session, and the read-back by native session id. */
export interface TaskRuntimeFreezePersistence {
  withSelection<T>(
    nodeRunId: string,
    body: (session: TaskRuntimeFreezeSession) => Promise<T>,
  ): Promise<T>
  findBySessionId(sessionId: string): Promise<FrozenTaskRuntimeRecord | null>
}
