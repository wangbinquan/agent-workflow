import { ConflictError } from '@/util/errors'
import type { MrTerminalControlWorker } from './mrTerminalControlWorker'
import { waitForExecutionActivation } from '@/platform/background/activation'

export interface MrTerminalExecutionLifetime {
  readonly current: () => boolean
  readonly whenActive?: Promise<boolean>
  readonly canDispatch?: () => boolean
}
export interface MrTerminalExecutionLifecycle {
  start(lifetime: MrTerminalExecutionLifetime): Promise<void>
  quiesce(lifetime: MrTerminalExecutionLifetime): void
  awaitDrained(lifetime: MrTerminalExecutionLifetime): Promise<void>
  pause(lifetime: MrTerminalExecutionLifetime): Promise<void>
}
export interface MrLaunchExecutionAdmission {
  current(): boolean
  run<T>(work: () => Promise<T>): Promise<T>
  settle(work: () => Promise<void>): Promise<void>
  release(): void
}
export interface MrLaunchExecutionPort {
  admit(): MrLaunchExecutionAdmission
}

export class MrTerminalExecutionUnavailable extends ConflictError {
  constructor() {
    super('webhook-mr-execution-unavailable', 'Webhook execution is not active on this host')
  }
}

interface Frame {
  readonly lifetime: MrTerminalExecutionLifetime
  readonly current: () => boolean
  readonly dispatch: () => boolean
  readonly activation: AbortController
  readonly pending: Set<Promise<unknown>>
  readonly settlements: Set<() => Promise<void>>
  readonly launches: Set<object>
  readonly changed: Set<() => void>
  ready: boolean
  accepting: boolean
  quiesced: boolean
  drained: boolean
  starting?: Promise<void>
  pausing?: Promise<void>
}

/** Owns only execution lifetimes; construction performs no recovery or I/O. */
export class MrTerminalExecutionController
  implements MrTerminalExecutionLifecycle, MrLaunchExecutionPort
{
  private frame: Frame | undefined
  constructor(private readonly worker: MrTerminalControlWorker) {}

  get selected(): MrTerminalExecutionLifetime | undefined {
    return this.frame?.lifetime
  }
  current(): boolean {
    return this.frame ? this.frame.current() && this.frame.dispatch() : false
  }
  requireReady(): void {
    if (
      !this.frame?.ready ||
      !this.frame.accepting ||
      !this.frame.current() ||
      !this.frame.dispatch()
    )
      throw new MrTerminalExecutionUnavailable()
  }

  start(lifetime: MrTerminalExecutionLifetime): Promise<void> {
    const prior = this.frame
    if (prior?.lifetime === lifetime && !prior.quiesced)
      return prior.starting ?? Promise.reject(new Error('mr-terminal-start-reentrant'))
    if (prior !== undefined && !prior.drained)
      return Promise.reject(new Error('mr-terminal-prior-lifetime-not-drained'))
    const current = lifetime.current.bind(lifetime)
    const dispatch = lifetime.canDispatch?.bind(lifetime)
    if (!current()) return Promise.reject(new MrTerminalExecutionUnavailable())
    const frame: Frame = {
      lifetime,
      current: () => current() && this.frame === frame && !frame.quiesced,
      dispatch: () => dispatch?.() ?? true,
      activation: new AbortController(),
      pending: new Set(),
      settlements: new Set(),
      launches: new Set(),
      changed: new Set(),
      ready: false,
      accepting: true,
      quiesced: false,
      drained: false,
    }
    this.frame = frame
    // Register the original boot work before effects, including synchronous reentry.
    const boot = this.run(frame, async () => {
      if (!frame.current()) throw new MrTerminalExecutionUnavailable()
      this.worker.prepareAuthority()
      await this.worker.reconcileOnBoot()
      if (!frame.current()) throw new MrTerminalExecutionUnavailable()
    })
    frame.starting = (async () => {
      try {
        await boot
        if (!frame.current()) throw new MrTerminalExecutionUnavailable()
        frame.ready = true
        if (lifetime.whenActive)
          void this.run(frame, async () => {
            if (
              (await waitForExecutionActivation(lifetime.whenActive, frame.activation.signal)) &&
              frame.current() &&
              frame.dispatch()
            )
              this.worker.wake()
          }).catch(() => {})
      } catch (error) {
        if (this.frame !== frame) throw error
        this.quiesce(lifetime)
        try {
          await this.awaitDrained(lifetime)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Webhook start cleanup failed')
        }
        throw error
      }
    })()
    return frame.starting
  }

  private require(lifetime: MrTerminalExecutionLifetime): Frame {
    if (this.frame?.lifetime !== lifetime) throw new Error('mr-terminal-lifetime-mismatch')
    return this.frame
  }
  private notify(frame: Frame): void {
    for (const wake of frame.changed) wake()
    frame.changed.clear()
  }
  private run<T>(frame: Frame, work: () => Promise<T>): Promise<T> {
    if (frame.drained) return Promise.reject(new Error('mr-terminal-lifetime-retired'))
    const pending = Promise.resolve().then(work)
    frame.pending.add(pending)
    const finished = () => {
      frame.pending.delete(pending)
      this.notify(frame)
    }
    void pending.then(finished, finished)
    return pending
  }

  admit(): MrLaunchExecutionAdmission {
    this.requireReady()
    const frame = this.frame!
    const launch = Object.freeze({})
    let released = false
    frame.launches.add(launch)
    return {
      current: () => !released && frame.accepting && frame.current() && frame.dispatch(),
      run: <T>(work: () => Promise<T>) =>
        released
          ? Promise.reject(new Error('mr-launch-admission-released'))
          : this.run(frame, work),
      settle: (work) => {
        if (released || frame.drained)
          return Promise.reject(new Error('mr-launch-admission-released'))
        let done = false
        let running: Promise<void> | undefined
        const settle = (): Promise<void> => {
          if (done) return Promise.resolve()
          if (running !== undefined) return running
          running = this.run(frame, async () => {
            await work()
            done = true
            frame.settlements.delete(settle)
          }).finally(() => {
            running = undefined
          })
          return running
        }
        frame.settlements.add(settle)
        return settle()
      },
      release: () => {
        released = true
        frame.launches.delete(launch)
        this.notify(frame)
      },
    }
  }

  quiesce(lifetime: MrTerminalExecutionLifetime): void {
    const frame = this.require(lifetime)
    frame.accepting = false
    frame.ready = false
    frame.quiesced = true
    frame.activation.abort()
    this.worker.quiesceAuthorityLoss()
    this.notify(frame)
  }
  async awaitDrained(lifetime: MrTerminalExecutionLifetime): Promise<void> {
    const frame = this.require(lifetime)
    if (!frame.quiesced) throw new Error('mr-terminal-drain-before-quiesce')
    await this.worker.drainAuthorityLoss()
    for (;;) {
      if (frame.pending.size > 0) {
        await Promise.allSettled([...frame.pending])
        continue
      }
      for (const settle of [...frame.settlements]) await settle()
      if (frame.launches.size === 0 && frame.pending.size === 0) break
      await new Promise<void>((resolve) => frame.changed.add(resolve))
    }
    frame.drained = true
  }
  pause(lifetime: MrTerminalExecutionLifetime): Promise<void> {
    const frame = this.require(lifetime)
    if (frame.drained) return Promise.resolve()
    if (frame.quiesced) return this.awaitDrained(lifetime)
    if (frame.pausing !== undefined) return frame.pausing
    frame.accepting = false
    frame.ready = false
    frame.pausing = (async () => {
      try {
        await this.worker.stop()
      } finally {
        this.quiesce(lifetime)
      }
      await this.awaitDrained(lifetime)
    })().catch((error: unknown) => {
      frame.pausing = undefined
      throw error
    })
    return frame.pausing
  }
}
