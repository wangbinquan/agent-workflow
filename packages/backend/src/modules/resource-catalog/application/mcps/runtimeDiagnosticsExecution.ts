import { ConflictError } from '@/util/errors'

/** The owning root supplies the same lifetime to start, quiesce and drain. */
export interface McpDiagnosticsExecutionLifetime {
  readonly current: () => boolean
  readonly whenActive?: Promise<boolean>
  readonly canDispatch?: () => boolean
  readonly reportFailure?: (error: unknown) => void
}

export interface McpDiagnosticsExecutionLifecycle {
  start(lifetime: McpDiagnosticsExecutionLifetime): Promise<void>
  quiesce(lifetime: McpDiagnosticsExecutionLifetime): void
  awaitDrained(lifetime: McpDiagnosticsExecutionLifetime): Promise<void>
  /** Ordinary provider pause retains the original explicit shutdown policy. */
  pause(lifetime: McpDiagnosticsExecutionLifetime, budgetMs?: number): Promise<void>
}

export class McpDiagnosticsExecutionUnavailable extends ConflictError {
  constructor() {
    super('mcp-test-execution-unavailable', 'MCP test execution is not active on this host')
  }
}

/** Application-private frame. Pending entries cover complete operations, not SQL calls. */
export interface McpDiagnosticsExecutionFrame {
  readonly lifetime: McpDiagnosticsExecutionLifetime
  readonly current: () => boolean
  readonly canDispatch: () => boolean
  readonly activation: AbortController
  readonly pending: Set<Promise<unknown>>
  readonly failures: unknown[]
  readonly settlements: Map<
    object,
    { retry(): Promise<unknown>; failure: unknown; subject?: string }
  >
  readonly settlementFailures: Set<unknown>
  readonly reportFailure: (error: unknown) => void
  ready: boolean
  quiesced: boolean
  drained: boolean
  starting: Promise<void> | undefined
  draining: Promise<void> | undefined
  reconciling: Promise<void> | undefined
}

/** No timers, recovery or effects are created by this controller. */
export class McpDiagnosticsExecutionController {
  private frame: McpDiagnosticsExecutionFrame | undefined

  get selected(): McpDiagnosticsExecutionFrame | undefined {
    return this.frame
  }

  requireReady(): McpDiagnosticsExecutionFrame {
    const frame = this.frame
    if (frame === undefined || !frame.canDispatch()) {
      throw new McpDiagnosticsExecutionUnavailable()
    }
    return frame
  }

  start(
    lifetime: McpDiagnosticsExecutionLifetime,
    work: (frame: McpDiagnosticsExecutionFrame) => Promise<void>,
  ): Promise<void> {
    const prior = this.frame
    if (prior?.lifetime === lifetime && !prior.quiesced) {
      return prior.starting ?? Promise.reject(new Error('mcp-test-execution-start-reentrant'))
    }
    if (prior !== undefined && !prior.drained) {
      return Promise.reject(new Error('mcp-test-execution-prior-lifetime-not-drained'))
    }
    const current = lifetime.current.bind(lifetime)
    const canDispatch = lifetime.canDispatch?.bind(lifetime)
    const reportFailure = lifetime.reportFailure?.bind(lifetime)
    if (!current()) return Promise.reject(new McpDiagnosticsExecutionUnavailable())
    const frame: McpDiagnosticsExecutionFrame = {
      lifetime,
      current: () => current() && this.frame === frame && !frame.quiesced,
      canDispatch: () =>
        frame.current() &&
        frame.ready &&
        frame.failures.length === 0 &&
        frame.settlements.size === 0 &&
        (canDispatch?.() ?? true),
      activation: new AbortController(),
      pending: new Set(),
      failures: [],
      settlements: new Map(),
      settlementFailures: new Set(),
      reportFailure: (error) => {
        if (frame.current()) reportFailure?.(error)
      },
      ready: false,
      quiesced: false,
      drained: false,
      starting: undefined,
      draining: undefined,
      reconciling: undefined,
    }
    this.frame = frame
    // Reserve the start promise before calling any user-supplied persistence/effect.
    let resolve!: () => void
    let reject!: (error: unknown) => void
    frame.starting = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void this.track(frame, async () => {
      await work(frame)
      if (!frame.current()) throw new McpDiagnosticsExecutionUnavailable()
      frame.ready = true
    }).then(resolve, reject)
    return frame.starting
  }

  /** Reserve before invoking work, including synchronous reentry into quiesce/drain. */
  track<T>(
    frame: McpDiagnosticsExecutionFrame,
    work: () => Promise<T>,
    retainFailure = false,
  ): Promise<T> {
    if (frame.drained || this.frame !== frame) {
      return Promise.reject(new Error('mcp-test-execution-frame-retired'))
    }
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (error: unknown) => void
    const pending = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    frame.pending.add(pending)
    void pending.then(
      () => frame.pending.delete(pending),
      (error: unknown) => {
        if (
          retainFailure &&
          !frame.settlementFailures.has(error) &&
          !(error instanceof McpDiagnosticsExecutionUnavailable)
        ) {
          frame.failures.push(error)
        }
        frame.pending.delete(pending)
      },
    )
    try {
      resolve(work())
    } catch (error) {
      reject(error)
    }
    return pending
  }

  /** Retain only an original settlement callback. It must never claim a new
   * turn, prepare another execution or invoke runTurn again. */
  settle<T>(
    frame: McpDiagnosticsExecutionFrame,
    work: () => Promise<T>,
    subject?: string,
  ): Promise<T> {
    const key = Object.freeze({})
    const attempt = (): Promise<T> =>
      this.track(frame, work).then(
        (value) => {
          frame.settlements.delete(key)
          return value
        },
        (error) => {
          frame.settlementFailures.add(error)
          frame.settlements.set(key, { retry: attempt, failure: error, subject })
          frame.reportFailure(error)
          throw error
        },
      )
    return attempt()
  }

  retrySettlements(frame: McpDiagnosticsExecutionFrame, subject?: string): Promise<void> {
    if (this.frame !== frame || frame.drained)
      return Promise.reject(new Error('mcp-test-execution-frame-retired'))
    if (frame.reconciling)
      return frame.reconciling.catch(() => {}).then(() => this.retrySettlements(frame, subject))
    const retrying = Promise.resolve()
      .then(async () => {
        const selected = () =>
          [...frame.settlements.values()].filter(
            (entry) => subject === undefined || entry.subject === subject,
          )
        const attempted = selected()
        await Promise.allSettled(attempted.map((entry) => entry.retry()))
        const failures = selected().map((entry) => entry.failure)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1)
          throw new AggregateError(failures, 'MCP original settlement retry failed')
      })
      .finally(() => {
        if (frame.reconciling === retrying) frame.reconciling = undefined
      })
    frame.reconciling = retrying
    return retrying
  }

  private require(lifetime: McpDiagnosticsExecutionLifetime): McpDiagnosticsExecutionFrame {
    if (this.frame === undefined || this.frame.lifetime !== lifetime) {
      throw new Error('mcp-test-execution-lifetime-mismatch')
    }
    return this.frame
  }

  quiesce(lifetime: McpDiagnosticsExecutionLifetime): void {
    const frame = this.require(lifetime)
    frame.quiesced = true
    frame.activation.abort()
    frame.ready = false
  }

  awaitDrained(lifetime: McpDiagnosticsExecutionLifetime): Promise<void> {
    const frame = this.require(lifetime)
    if (!frame.quiesced) return Promise.reject(new Error('mcp-test-execution-drain-before-quiesce'))
    if (frame.drained) return Promise.resolve()
    if (frame.draining) return frame.draining
    const tried = new Set<object>()
    const draining = Promise.resolve()
      .then(async () => {
        await frame.reconciling?.catch(() => {})
        // Re-read after original callbacks/broadcasts settle. A failed callback
        // is attempted at most once per drain, so a persistent failure remains
        // visible without a retry loop or a fabricated acknowledgement.
        for (;;) {
          while (frame.pending.size > 0) await Promise.allSettled([...frame.pending])
          const next = [...frame.settlements].filter(([key]) => !tried.has(key))
          if (next.length === 0) break
          for (const [key] of next) tried.add(key)
          await Promise.allSettled(next.map(([, entry]) => entry.retry()))
        }
        const failures = [
          ...frame.failures,
          ...[...frame.settlements.values()].map((entry) => entry.failure),
        ]
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1)
          throw new AggregateError(failures, 'MCP execution settlement failed')
        frame.drained = true
      })
      .finally(() => {
        if (frame.draining === draining) frame.draining = undefined
      })
    frame.draining = draining
    return draining
  }
}
