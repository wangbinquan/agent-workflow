// RFC-349 — bootstrap-only lifecycle for a live provider composition.
//
// A session is created in a frozen state: HTTP/WS/background writers are not
// admitted until `resume`. This controller deliberately knows no database
// client and no business adapter. It only makes provider replacement atomic at
// the daemon-composition boundary used by database-migration admission.

export type DaemonProviderKind = 'sqlite' | 'postgresql'

export interface DaemonProviderSessionLifecycleInput {
  readonly operationId: string
  readonly provider: DaemonProviderKind
  readonly generationId: string
}

export interface ManagedDaemonProviderSession {
  readonly provider: DaemonProviderKind
  readonly generationId: string
  /** Stop accepting/producing background work and wait for its writers to drain. */
  pause(input: DaemonProviderSessionLifecycleInput): Promise<void>
  /** Start this already-composed session's background writers. */
  resume(input: DaemonProviderSessionLifecycleInput): Promise<void>
  /** Release every provider-owned resource. Must be safe to retry after failure. */
  close(input: { readonly reason: 'provider-switch' | 'daemon-shutdown' }): Promise<void>
}

export interface DaemonProviderSessionFactory<Session extends ManagedDaemonProviderSession> {
  /**
   * Build and verify a complete provider composition without admitting work.
   * The returned session stays frozen until the controller calls `resume`.
   */
  create(input: DaemonProviderSessionLifecycleInput): Promise<Session>
}

export interface DaemonProviderSessionController<Session extends ManagedDaemonProviderSession> {
  current(): Session
  /**
   * Non-null exactly while `current` is being replaced. Listener delegates must
   * await it before they resolve `current`: composing the target reads and
   * writes through process-wide provider state (RFC-349's shared table
   * projection), so a request served by the outgoing composition inside that
   * window compiles target-shaped SQL against the source client and fails with
   * an opaque driver error. Holding is bounded by the composition build and is
   * the difference between a slightly slow control-plane poll and a 500.
   */
  handover(): Promise<void> | null
  pauseBackgroundWriters(input: DaemonProviderSessionLifecycleInput): Promise<void>
  switchProviderComposition(input: DaemonProviderSessionLifecycleInput): Promise<void>
  resumeBackgroundWriters(input: DaemonProviderSessionLifecycleInput): Promise<void>
  stop(): Promise<void>
}

export class DaemonProviderSessionError extends Error {
  constructor(
    public readonly code:
      | 'daemon-provider-session-stopped'
      | 'daemon-provider-session-operation-conflict'
      | 'daemon-provider-session-state'
      | 'daemon-provider-session-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'DaemonProviderSessionError'
  }
}

function describeSession(session: ManagedDaemonProviderSession): string {
  return `${session.provider}/${session.generationId}`
}

/**
 * Flatten one provider-session failure into a single diagnostic line.
 *
 * Close failures arrive as nested `AggregateError`s: session stop wraps the
 * per-session close, which wraps the runtime freeze, which wraps each handle's
 * own stop/drain rejection. Logging only the outermost `message` prints
 * "failed to close daemon provider sessions" and drops every cause, which is
 * exactly the level at which an operator learns nothing (2026-09-02: every
 * SQLite shutdown logged that line with no way to tell which participant
 * failed). Callers log this instead of `error.message`.
 */
export function describeDaemonProviderSessionFailure(error: unknown): string {
  const seen = new Set<unknown>()
  const describe = (value: unknown): string => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '<circular>'
      seen.add(value)
    }
    if (value instanceof AggregateError) {
      const causes = value.errors.map(describe).filter((line) => line.length > 0)
      return causes.length === 0 ? value.message : `${value.message}: [${causes.join('; ')}]`
    }
    if (value instanceof Error) {
      const own = `${value.name}: ${value.message}`
      return value.cause === undefined ? own : `${own} <- ${describe(value.cause)}`
    }
    return String(value)
  }
  return describe(error)
}

function assertSessionMatches(
  session: ManagedDaemonProviderSession,
  input: DaemonProviderSessionLifecycleInput,
): void {
  if (session.provider !== input.provider || session.generationId !== input.generationId) {
    throw new DaemonProviderSessionError(
      'daemon-provider-session-mismatch',
      `composed daemon provider ${describeSession(session)} does not match requested ${input.provider}/${input.generationId}`,
    )
  }
}

export function createDaemonProviderSessionController<
  Session extends ManagedDaemonProviderSession,
>(input: {
  readonly initial: Session
  readonly factory: DaemonProviderSessionFactory<Session>
  /**
   * Called with whatever session owns the listener after every composition
   * attempt — the new one, or the source when the attempt failed. The
   * controller itself knows no provider state; bootstrap uses this to keep
   * process-wide provider selection pinned to the serving composition, which
   * is what makes a failed cutover leave a working daemon behind.
   */
  readonly onCurrentSelected?: (session: Session) => void
  /**
   * Awaited after the handover barrier is armed and before the target
   * composition is built. `handover()` only queues *new* listener calls; the
   * ones already dispatched to the outgoing composition keep running, and
   * composing the target moves process-wide provider state out from under them.
   * Bootstrap passes the listener's in-flight drain here. Bounded by the
   * implementation: a slow request must not be able to stall a cutover.
   */
  readonly quiesceListener?: () => Promise<void>
}): DaemonProviderSessionController<Session> {
  let current = input.initial
  let standby: Session | null = null
  let handoverBarrier: Promise<void> | null = null
  let pausedByOperationId: string | null = null
  let stopped = false
  const retired = new Set<Session>()
  let shutdownSessions: Set<Session> | null = null

  const assertLive = (): void => {
    if (stopped) {
      throw new DaemonProviderSessionError(
        'daemon-provider-session-stopped',
        'daemon provider session controller is stopped',
      )
    }
  }

  const assertOperation = (operationId: string): void => {
    if (pausedByOperationId !== operationId) {
      throw new DaemonProviderSessionError(
        'daemon-provider-session-operation-conflict',
        `daemon provider session belongs to ${pausedByOperationId ?? 'no migration operation'}`,
      )
    }
  }

  const closeRetired = async (session: Session): Promise<void> => {
    retired.add(session)
    try {
      await session.close({ reason: 'provider-switch' })
      retired.delete(session)
    } catch {
      // The session is frozen, so a close failure cannot admit a second writer.
      // Keep it reachable and retry during daemon shutdown; the successfully
      // resumed provider remains authoritative.
    }
  }

  return Object.freeze({
    current: () => current,
    handover: () => handoverBarrier,

    async pauseBackgroundWriters(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      assertLive()
      if (pausedByOperationId !== null) {
        assertOperation(lifecycleInput.operationId)
        return
      }
      assertSessionMatches(current, lifecycleInput)
      await current.pause(lifecycleInput)
      pausedByOperationId = lifecycleInput.operationId
    },

    async switchProviderComposition(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      assertLive()
      assertOperation(lifecycleInput.operationId)

      if (
        current.provider === lifecycleInput.provider &&
        current.generationId === lifecycleInput.generationId
      ) {
        return
      }

      // Everything below either replaces `current` or reinstates it after a
      // failed attempt, and composing a provider moves process-wide provider
      // state. Fence the listener for the whole attempt so no request is ever
      // served by a composition that no longer matches that state.
      let releaseHandover: () => void = () => {}
      handoverBarrier = new Promise<void>((resolve) => {
        releaseHandover = resolve
      })
      const settleHandover = (): void => {
        handoverBarrier = null
        input.onCurrentSelected?.(current)
        releaseHandover()
      }

      try {
        // New listener calls are queued behind the barrier above; drain the ones
        // already running before process-wide provider state moves.
        await input.quiesceListener?.()
        // Before target admission opens, rollback reuses the exact frozen source
        // composition instead of creating a second source session. The failed
        // candidate never admitted business/background work and can be retired.
        const rollbackStandby = standby
        if (
          rollbackStandby !== null &&
          rollbackStandby.provider === lifecycleInput.provider &&
          rollbackStandby.generationId === lifecycleInput.generationId
        ) {
          const failedCandidate = current
          current = rollbackStandby
          standby = null
          await closeRetired(failedCandidate)
          return
        }

        // `create` must finish while the old session remains the current frozen
        // composition. A failed candidate therefore leaves recovery able to
        // resume the exact source session.
        const candidate = await input.factory.create(lifecycleInput)
        try {
          assertSessionMatches(candidate, lifecycleInput)
        } catch (error) {
          try {
            await candidate.close({ reason: 'provider-switch' })
          } catch {
            // The mismatch is the authoritative bootstrap failure. A candidate
            // that cannot close never becomes current and has no admitted work.
          }
          throw error
        }

        const previous = current
        current = candidate
        if (standby !== null) await closeRetired(standby)
        // Do not close the frozen source yet. It is the cutover-horizon rollback
        // composition until the target has successfully started all writers.
        standby = previous
      } finally {
        settleHandover()
      }
    },

    async resumeBackgroundWriters(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      assertLive()
      assertOperation(lifecycleInput.operationId)
      assertSessionMatches(current, lifecycleInput)
      await current.resume(lifecycleInput)
      pausedByOperationId = null
      const previous = standby
      standby = null
      if (previous !== null) await closeRetired(previous)
    },

    async stop() {
      if (!stopped) {
        stopped = true
        shutdownSessions = new Set([current, ...(standby === null ? [] : [standby]), ...retired])
        standby = null
        retired.clear()
      }
      const sessions = [...(shutdownSessions ?? [])]
      if (sessions.length === 0) return
      const results = await Promise.allSettled(
        sessions.map((session) => session.close({ reason: 'daemon-shutdown' })),
      )
      const failures: unknown[] = []
      results.forEach((result, index) => {
        const session = sessions[index]!
        if (result.status === 'fulfilled') shutdownSessions?.delete(session)
        else failures.push(result.reason)
      })
      if (failures.length > 0) {
        throw new AggregateError(failures, 'failed to close daemon provider sessions')
      }
    },
  })
}
