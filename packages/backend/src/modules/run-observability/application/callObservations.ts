// RFC-371 v2 §4 — the offered write contract (re-exported by public/participants).

/** Frozen identity of one runtime child process, persisted before it is spawned. */
export interface CallObservationStart {
  readonly id: string
  readonly purpose: 'task' | 'system'
  readonly taskId: string | null
  readonly nodeRunId: string | null
  readonly systemKind?: string | null
  readonly systemLabel?: string | null
  /** Who started a task-less system call (its visibility). */
  readonly ownerUserId?: string | null
  readonly agentId: string | null
  readonly agentName: string
  readonly runtimeId: string | null
  readonly runtimeName: string | null
  readonly protocol: string
  readonly startedAt: number
}

/** A replaceable snapshot of one call's usage, split by the actual reported model. */
export interface CallObservedUsage {
  readonly state: 'partial' | 'complete'
  readonly models: readonly {
    readonly model: string
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  }[]
}

export interface CallObservations {
  /** Must succeed before spawn; a failure prevents an unrecorded process. */
  accept(call: CallObservationStart): Promise<void>
  /** Replace the running call's usage snapshot. */
  usage(callId: string, usage: CallObservedUsage): Promise<void>
  /** Final status and final snapshot (null: the runtime cannot meter usage). */
  finish(
    callId: string,
    outcome: {
      readonly status: 'done' | 'failed' | 'canceled' | 'interrupted'
      readonly endedAt: number
      readonly usage: CallObservedUsage | null
    },
  ): Promise<void>
}

export interface CallObservationLifecycle {
  /** Calls still marked running from before `bootAt` belonged to a previous daemon. */
  repairInterrupted(bootAt: number): Promise<number>
}
