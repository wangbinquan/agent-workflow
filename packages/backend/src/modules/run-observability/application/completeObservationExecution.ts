import { CompleteObservationError } from '../domain/completeObservationError'
import type { CompleteObservationStoredReport } from '../ports/completeObservationReport'

export interface ObservationExecutionLifetime {
  readonly current: () => boolean
  readonly whenActive?: Promise<boolean>
  readonly canDispatch?: () => boolean
}

export interface ObservationExecutionLifecycle {
  start(lifetime: ObservationExecutionLifetime): void | Promise<void>
  quiesce(lifetime: ObservationExecutionLifetime): void | Promise<void>
  awaitDrained(lifetime: ObservationExecutionLifetime): Promise<void>
  pause(lifetime: ObservationExecutionLifetime): Promise<void>
}

export interface CompleteObservationHostSelection {
  readonly mode: 'host'
  /** Only an original claim for which this service has not issued build(). */
  readonly deferUnissued: (report: CompleteObservationStoredReport) => Promise<void>
}

interface Settlement {
  readonly write: () => Promise<void>
  pending?: Promise<void>
}

interface ObservationExecutionFrame {
  readonly lifetime: ObservationExecutionLifetime
  readonly current: () => boolean
  readonly dispatch: () => boolean
  readonly pending: Set<Promise<unknown>>
  readonly settlements: Set<Settlement>
  quiesced: boolean
  drained: boolean
}

/** Tracks the original HTTP admission, queued job and durable settlement tails.
 * Loss closes admission without aborting any already issued original build. */
export class CompleteObservationExecution {
  private frame: ObservationExecutionFrame | undefined

  start(lifetime: ObservationExecutionLifetime): void {
    if (this.frame && !this.frame.drained)
      throw new Error('observation-report-prior-lifetime-not-drained')
    const current = lifetime.current.bind(lifetime)
    const dispatch = lifetime.canDispatch?.bind(lifetime)
    if (!current()) throw this.unavailable()
    this.frame = {
      lifetime,
      current,
      dispatch: () => dispatch?.() ?? true,
      pending: new Set(),
      settlements: new Set(),
      quiesced: false,
      drained: false,
    }
  }

  unavailable(): CompleteObservationError {
    return new CompleteObservationError('not-ready', 'Report execution is not available')
  }

  accepting(frame = this.frame): boolean {
    return (
      frame !== undefined &&
      frame === this.frame &&
      !frame.quiesced &&
      !frame.drained &&
      frame.current() &&
      frame.dispatch()
    )
  }

  controlCurrent(): boolean {
    return (
      this.frame !== undefined &&
      !this.frame.quiesced &&
      !this.frame.drained &&
      this.frame.current()
    )
  }

  admit(): ObservationExecutionFrame {
    if (!this.accepting()) throw this.unavailable()
    return this.frame!
  }

  track<T>(frame: ObservationExecutionFrame, operation: () => Promise<T>): Promise<T> {
    if (frame.drained) throw new Error('observation-report-retired-lifetime')
    // Register before invoking the original callback, including synchronous throws.
    const pending = Promise.resolve().then(operation)
    frame.pending.add(pending)
    void pending.finally(() => frame.pending.delete(pending)).catch(() => {})
    return pending
  }

  settle(frame: ObservationExecutionFrame, write: () => Promise<void>): Promise<void> {
    if (frame.drained) throw new Error('observation-report-retired-settlement')
    const settlement: Settlement = { write }
    frame.settlements.add(settlement)
    return this.write(frame, settlement)
  }

  private write(frame: ObservationExecutionFrame, settlement: Settlement): Promise<void> {
    if (settlement.pending) return settlement.pending
    const pending = this.track(frame, settlement.write)
    settlement.pending = pending
    void pending.then(() => frame.settlements.delete(settlement)).catch(() => {})
    void pending
      .finally(() => {
        settlement.pending = undefined
      })
      .catch(() => {})
    return pending
  }

  private require(lifetime: ObservationExecutionLifetime): ObservationExecutionFrame {
    if (this.frame?.lifetime !== lifetime) throw new Error('observation-report-lifetime-mismatch')
    return this.frame
  }

  quiesce(lifetime: ObservationExecutionLifetime): void {
    this.require(lifetime).quiesced = true
  }

  async awaitDrained(lifetime: ObservationExecutionLifetime): Promise<void> {
    const frame = this.require(lifetime)
    if (!frame.quiesced) throw new Error('observation-report-drain-before-quiesce')
    while (frame.pending.size) await Promise.allSettled([...frame.pending])
    // Retry only retained writes/cleanup, never a claim or the original build.
    for (const settlement of frame.settlements) await this.write(frame, settlement)
    frame.drained = true
  }
}
