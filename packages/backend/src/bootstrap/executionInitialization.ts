import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '@/modules/system-operations/public/participants'

/** HTTP readiness precedes lease acquisition. Business admission follows both
 * acquisition and boot recovery, so an inactive release cannot recover its
 * still-running predecessor's work. */
export function selectExecutionInitialization(raw: ExecutionAuthorityPort & { start(): void }): {
  readonly authority: ExecutionAuthorityPort
  readonly initialize: (work: () => Promise<void>) => Promise<void>
} {
  let initialized = false
  let registered = false
  let stopped = false
  let failure: ExecutionAuthorityState | undefined
  let activate!: (fence: ExecutionFence) => void
  const active = new Promise<ExecutionFence>((resolve) => {
    activate = resolve
  })
  const listeners = new Set<(state: ExecutionAuthorityState) => void>()
  const lost = (state: ExecutionAuthorityState) => {
    if (stopped) return
    stopped = true
    failure = state
    for (const listener of listeners) listener(state)
  }
  raw.onLost(lost)
  return {
    authority: {
      mode: raw.mode,
      current() {
        if (failure !== undefined) return failure
        const current = raw.current()
        return current.kind === 'active' && !initialized
          ? { kind: 'standby', reason: 'execution-recovery-in-progress' }
          : current
      },
      whenActive: () => active,
      onLost(listener) {
        listeners.add(listener)
        if (failure !== undefined) listener(failure)
        return () => {
          listeners.delete(listener)
        }
      },
      async close() {
        stopped = true
        await raw.close()
      },
    },
    async initialize(work) {
      if (registered) throw new Error('execution-initialization-already-registered')
      registered = true
      void raw
        .whenActive()
        .then(async (fence) => {
          if (stopped) return
          await work()
          if (stopped || raw.current().kind !== 'active') return
          initialized = true
          activate(fence)
        })
        .catch((error: unknown) => {
          lost({
            kind: 'frozen',
            reason: `execution-initialization-failed: ${error instanceof Error ? error.message : String(error)}`,
          })
        })
      raw.start()
    },
  }
}
