import { waitForExecutionActivation } from '@/platform/background/activation'
import type {
  IntentExecutionAuthority,
  IntentExecutionControl,
  IntentTurnExecutionLifecycle,
} from './ports/intentExecution'

export class IntentOriginalExecutionPendingError extends Error {
  constructor(
    readonly turnId: string,
    private readonly acknowledged: () => boolean,
    cause?: unknown,
  ) {
    super('intent-original-execution-pending', { cause })
    this.name = 'IntentOriginalExecutionPendingError'
  }
  originalRecoveryAcknowledged(): boolean {
    return this.acknowledged()
  }
}

export class IntentExecutionDeferredError extends Error {
  constructor() {
    super('intent-execution-admission-deferred')
    this.name = 'IntentExecutionDeferredError'
  }
}

interface TurnWork {
  readonly turnId: string
  readonly run: (control: IntentExecutionControl) => Promise<void>
  done?: Promise<void>
  blocked?: {
    readonly retry: () => Promise<boolean>
    readonly resume: () => void
    readonly error: Error
  }
  recovering?: Promise<boolean>
  failure?: unknown
  acknowledged: boolean
  requiresSettlement: boolean
  readonly changed: Set<() => void>
  readonly predecessor?: TurnWork
}

/** One owner covers HTTP, queued and automatic turns. Loss only closes intake:
 * already issued turns finish against their original providers and receipts. */
export function createIntentTurnExecutionLifecycle(): IntentTurnExecutionLifecycle {
  const turns = new Map<string, TurnWork>()
  let recovery: Parameters<IntentTurnExecutionLifecycle['configureRecovery']>[0] | undefined
  let current:
    | {
        stopped: boolean
        readonly authority: IntentExecutionAuthority
        readonly activation: AbortController
        activating?: Promise<void>
      }
    | undefined

  const report = (error: unknown) => current?.authority.reportFailure?.(error)
  const admit = (frame: NonNullable<typeof current>) =>
    !frame.stopped && frame.authority.current() && (frame.authority.canDispatch?.() ?? true)
  const notify = (turn: TurnWork) => {
    for (const changed of [...turn.changed]) changed()
    turn.changed.clear()
  }
  const waitState = (turn: TurnWork): Promise<void> => {
    if (turn.acknowledged || turn.blocked || turn.failure) return Promise.resolve()
    return new Promise<void>((resolve) => turn.changed.add(resolve))
  }

  const run = (turn: TurnWork, authorized: () => boolean): Promise<void> => {
    if (turn.done) return turn.done
    if (authorized()) turn.requiresSettlement = true
    const block = async (retry: () => Promise<boolean>, cause?: unknown) => {
      let resume!: () => void
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      const error = new IntentOriginalExecutionPendingError(
        turn.turnId,
        () => turn.acknowledged,
        cause,
      )
      turn.blocked = { retry, resume, error }
      notify(turn)
      report(error)
      await resumed
    }
    const control: IntentExecutionControl = Object.freeze({
      current: authorized,
      async checkpoint<T>(write: () => Promise<T>): Promise<T> {
        try {
          return await write()
        } catch (cause) {
          let value!: T
          await block(async () => {
            value = await write()
            return true
          }, cause)
          return value
        }
      },
      holdOriginal: (recover) => block(recover),
    })
    const done = Promise.resolve()
      .then(() => turn.run(control))
      .then(() => {
        turn.acknowledged = true
        for (let previous = turn.predecessor; previous; previous = previous.predecessor)
          previous.acknowledged = true
        turns.delete(turn.turnId)
        notify(turn)
      })
      .catch((error: unknown) => {
        if (error instanceof IntentExecutionDeferredError) {
          turn.done = undefined
          turn.requiresSettlement = false
          notify(turn)
          return
        }
        turn.failure = error
        notify(turn)
        report(error)
        throw error
      })
    turn.done = done
    void done.catch(() => {})
    return done
  }

  const recoverOriginal = (turnId: string): Promise<boolean> => {
    const turn = turns.get(turnId)
    if (!turn) {
      if (!recovery) return Promise.resolve(false)
      return Promise.resolve().then(async () => {
        const checkpoint = (await recovery!.load()).find(
          (value) => value.reservation.turnId === turnId,
        )
        if (!checkpoint) return true
        if (checkpoint.phase === 'reserved') return false
        if (turns.has(turnId)) return recoverOriginal(turnId)
        const cold: TurnWork = {
          turnId,
          run: (control) => recovery!.recover(checkpoint, control),
          acknowledged: false,
          requiresSettlement: true,
          changed: new Set(),
        }
        turns.set(turnId, cold)
        void run(cold, () => false)
        await waitState(cold)
        if (cold.acknowledged) return true
        return recoverOriginal(turnId)
      })
    }
    if (turn.recovering) return turn.recovering
    if (!turn.blocked) {
      if (!turn.failure || !recovery) return Promise.resolve(false)
      const retry = Promise.resolve()
        .then(async () => {
          const checkpoint = (await recovery!.load()).find(
            (value) => value.reservation.turnId === turnId,
          )
          if (!checkpoint || checkpoint.phase === 'reserved') return false
          const resumed: TurnWork = {
            turnId,
            run: (control) => recovery!.recover(checkpoint, control),
            acknowledged: false,
            requiresSettlement: true,
            changed: new Set(),
            predecessor: turn,
          }
          turns.set(turnId, resumed)
          void run(resumed, () => false)
          await waitState(resumed)
          if (resumed.failure) throw resumed.failure
          return resumed.acknowledged
        })
        .finally(() => {
          if (turn.recovering === retry) turn.recovering = undefined
        })
      turn.recovering = retry
      return retry
    }
    const pending = turn.blocked
    const recovering = Promise.resolve()
      .then(async () => {
        if (!(await pending.retry())) return false
        if (turn.blocked === pending) turn.blocked = undefined
        pending.resume()
        // Completion acknowledges the whole original turn tail. A later ACK
        // failure remains pending; callers can explicitly retry it again.
        await waitState(turn)
        if (turn.failure) throw turn.failure
        return turn.acknowledged
      })
      .finally(() => {
        if (turn.recovering === recovering) turn.recovering = undefined
      })
    turn.recovering = recovering
    return recovering
  }

  return Object.freeze({
    configureRecovery(input) {
      if (recovery) throw new Error('intent-execution-recovery-already-selected')
      recovery = Object.freeze({ load: input.load.bind(input), recover: input.recover.bind(input) })
    },
    async prepare() {
      if (!recovery) throw new Error('intent-execution-recovery-missing')
      for (const checkpoint of await recovery.load()) {
        const turnId = checkpoint.reservation.turnId
        if (turns.has(turnId)) continue
        // Unissued reservations retain their original ID, nonce and budget and
        // wait for activation. No model runs during preparation.
        const turn: TurnWork = {
          turnId,
          run: (control) => recovery!.recover(checkpoint, control),
          acknowledged: false,
          requiresSettlement: checkpoint.phase !== 'reserved',
          changed: new Set(),
        }
        turns.set(turnId, turn)
        if (checkpoint.phase !== 'reserved') {
          // Cold recovery enters the same result tail, never the model call.
          void run(turn, () => false)
          await waitState(turn)
        }
      }
      // A cold result can mint a graph-repair reservation. Finish persisting
      // that unissued reservation before the single activation walk begins.
      for (const turn of turns.values())
        if (!turn.requiresSettlement && turn.done) {
          await Promise.race([turn.done, waitState(turn)])
          if (turn.blocked) throw turn.blocked.error
          if (turn.failure) throw turn.failure
        }
      const issued = [...turns.values()].filter(
        (turn) => turn.requiresSettlement && turn.done && !turn.acknowledged,
      )
      if (issued[0])
        throw new IntentOriginalExecutionPendingError(issued[0].turnId, () =>
          issued.every((turn) => turn.acknowledged),
        )
    },
    dispatch(turnId, work) {
      const existing = turns.get(turnId)
      if (existing) return existing.done ?? Promise.resolve()
      const turn: TurnWork = {
        turnId,
        run: work,
        acknowledged: false,
        requiresSettlement: false,
        changed: new Set(),
      }
      turns.set(turnId, turn)
      const frame = current
      return run(turn, () => frame !== undefined && admit(frame))
    },
    recoverOriginal,
    start(authority) {
      if (current) throw new Error('intent-execution-already-started')
      const frame = {
        stopped: false,
        authority: Object.freeze({
          current: authority.current.bind(authority),
          ...(authority.canDispatch ? { canDispatch: authority.canDispatch.bind(authority) } : {}),
          ...(authority.reportFailure
            ? { reportFailure: authority.reportFailure.bind(authority) }
            : {}),
        }),
        activation: new AbortController(),
        activating: undefined as Promise<void> | undefined,
      }
      current = frame
      const activate = () => {
        if (!admit(frame)) return
        for (const turn of turns.values()) if (!turn.done) void run(turn, () => admit(frame))
      }
      if (authority.whenActive)
        frame.activating = waitForExecutionActivation(
          authority.whenActive,
          frame.activation.signal,
        ).then((active) => {
          if (active) activate()
        })
      else activate()
      return Object.freeze({
        stop() {
          frame.stopped = true
          frame.activation.abort()
        },
        async drain() {
          if (!frame.stopped) throw new Error('intent-execution-drain-before-stop')
          await frame.activating
          for (const turn of turns.values()) {
            if (turn.blocked) throw turn.blocked.error
            if (turn.failure) throw turn.failure
            if (turn.done) {
              await Promise.race([turn.done, waitState(turn)])
              if (turn.blocked) throw turn.blocked.error
              if (turn.failure) throw turn.failure
            }
          }
          if (current === frame) current = undefined
        },
      })
    },
  } satisfies IntentTurnExecutionLifecycle)
}
