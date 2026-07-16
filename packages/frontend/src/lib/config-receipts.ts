// RFC-201 PR-A — causal receipts for the shared /api/config resource.
//
// The coordinator is deliberately route/tab local. It orders writers in this
// browser tab, while issued read epochs let the owning draft reducer reject a
// GET that was already in flight when a later PUT settled.

import type { Config, ConfigPatch } from '@agent-workflow/shared'

export interface ConfigReceiptTransport {
  read(signal?: AbortSignal): Promise<Config>
  write(patch: ConfigPatch, signal?: AbortSignal): Promise<Config>
}

export interface ConfigReceiptCoordinatorOptions {
  /** HTTP/API rejections prove no successful write; transport loss does not. */
  isDefinitiveWriteError?: (error: unknown) => boolean
  /** Stable daemon/base-url key used to preserve a writer barrier across A→B→A. */
  initialResourceKey?: string
}

export interface ResetConfigReceiptGenerationOptions {
  /** True only when the daemon/base-url resource itself changed. */
  resourceChanged?: boolean
  /** Canonical key for the newly active resource (normally its base URL). */
  resourceKey?: string
}

export interface ConfigReadReceipt {
  readonly type: 'read'
  /** Exact full Config returned by GET /api/config. */
  readonly config: Config
  /** Auth/base-url generation captured when the GET was issued. */
  readonly generation: number
  /** Monotonic epoch allocated when the GET is issued, not when it completes. */
  readonly issuedEpoch: number
}

export interface ConfigWriteReceipt {
  readonly type: 'write'
  /** Exact full Config returned by PUT /api/config. */
  readonly config: Config
  /** Auth/base-url generation captured when this PUT entered the FIFO. */
  readonly generation: number
  /** Monotonic epoch allocated when this PUT enters the local FIFO. */
  readonly writeEpoch: number
  /**
   * Every read at or below this epoch was already issued when this write
   * settled and must not overwrite the exact mutation receipt if it arrives
   * later.
   */
  readonly ignoreReadsThroughEpoch: number
  /**
   * Authoritative GET issued automatically after the write receipt is
   * published. Its read epoch is always above ignoreReadsThroughEpoch.
   * A refetch failure does not turn the already-settled PUT into a failure.
   */
  readonly postSettleRefetch: Promise<ConfigReadReceipt>
}

export type ConfigReceipt = ConfigReadReceipt | ConfigWriteReceipt

export interface ConfigReadFence {
  readonly generation: number
  readonly ignoreReadsThroughEpoch?: number
  readonly lastAcceptedReadEpoch?: number
}

export class ConfigReceiptGenerationError extends Error {
  readonly code = 'config-receipt-generation-changed'

  constructor(
    readonly expectedGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(`config transport generation changed from ${expectedGeneration} to ${currentGeneration}`)
    this.name = 'ConfigReceiptGenerationError'
  }
}

/**
 * The client lost the PUT response, so it cannot prove whether the server will
 * still commit that write. A single follow-up GET may race ahead of the server
 * handler and is therefore useful for UI reconciliation, but not as permission
 * to send another ordered write in this transport generation.
 */
export class ConfigAmbiguousWriteError extends Error {
  readonly code = 'config-write-outcome-unknown'

  constructor(
    readonly generation: number,
    readonly writeEpoch: number,
    readonly originalError: unknown,
  ) {
    const detail =
      originalError instanceof Error
        ? originalError.message
        : 'the config write response was lost before its outcome was known'
    super(`${detail}; restart the daemon, then reload this page before writing configuration again`)
    this.name = 'ConfigAmbiguousWriteError'
  }
}

/** A later write was rejected before transport because an earlier one is unknown. */
export class ConfigWriteQueueBlockedError extends Error {
  readonly code = 'config-write-queue-blocked'

  constructor(
    readonly generation: number,
    readonly blockedByWriteEpoch: number,
  ) {
    super(
      'config writes are blocked because an earlier write has an unknown outcome; restart the daemon, then reload this page before writing configuration again',
    )
    this.name = 'ConfigWriteQueueBlockedError'
  }
}

/**
 * Test a GET receipt against the owning scope's causal read fence. Completion
 * time is intentionally absent: only issue order is valid causality evidence.
 */
export function shouldAcceptConfigReadReceipt(
  receipt: Pick<ConfigReadReceipt, 'generation' | 'issuedEpoch'>,
  fence: ConfigReadFence,
): boolean {
  if (receipt.generation !== fence.generation) return false
  const ignoreThrough = fence.ignoreReadsThroughEpoch ?? 0
  const lastAccepted = fence.lastAcceptedReadEpoch ?? 0
  return receipt.issuedEpoch > ignoreThrough && receipt.issuedEpoch >= lastAccepted
}

interface ConfigWriterState {
  tail: Promise<void>
  blockedWrite?: { writeEpoch: number; error: ConfigAmbiguousWriteError }
}

export class ConfigReceiptCoordinator {
  private generation = 1
  private issuedReadEpoch = 0
  private issuedWriteEpoch = 0
  private ignoreReadsThroughEpoch = 0
  private lastAcceptedReadEpoch = 0
  private readonly writerStates = new Map<string, ConfigWriterState>()
  private activeResourceKey: string
  private anonymousResourceSequence = 0
  private snapshot: ConfigReceipt | undefined
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly transport: ConfigReceiptTransport,
    private readonly options: ConfigReceiptCoordinatorOptions = {},
  ) {
    this.activeResourceKey = options.initialResourceKey ?? 'resource:initial'
    this.writerStates.set(this.activeResourceKey, { tail: Promise.resolve() })
  }

  /** Current auth/base-url generation; store it in every reducer read fence. */
  get currentGeneration(): number {
    return this.generation
  }

  /** Latest causally accepted read or exact write receipt. */
  getSnapshot = (): ConfigReceipt | undefined => this.snapshot

  /** Current same-resource response-loss barrier, if writes are fail-closed. */
  getWriteBlock = (): ConfigAmbiguousWriteError | undefined =>
    this.currentWriterState().blockedWrite?.error

  /** Subscribe without depending on React; suitable for useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Fence requests from the previous auth/base-url identity. Call this whenever
   * either transport input changes. Old queued writes are detached from the new
   * generation and cannot start against the new daemon.
   */
  resetGeneration(options: ResetConfigReceiptGenerationOptions = {}): number {
    this.generation += 1
    this.ignoreReadsThroughEpoch = 0
    this.lastAcceptedReadEpoch = 0
    if (options.resourceChanged ?? true) {
      this.activeResourceKey =
        options.resourceKey ?? `resource:anonymous:${++this.anonymousResourceSequence}`
      if (!this.writerStates.has(this.activeResourceKey)) {
        this.writerStates.set(this.activeResourceKey, { tail: Promise.resolve() })
      }
    }
    this.publish(undefined)
    return this.generation
  }

  /**
   * Issue a read immediately in causal order and return its raw receipt.
   * Causally accepted receipts are also exposed through getSnapshot/subscribe;
   * a stale same-generation receipt is returned here for explicit fence logic
   * but is never published as the accepted snapshot.
   */
  read(signal?: AbortSignal): Promise<ConfigReadReceipt> {
    const generation = this.generation
    // Reads requested after a local write entered the FIFO are barriers too.
    // In particular, a credential rotation may fence the old response while
    // the same-daemon write still commits; the fresh credential must not publish
    // a pre-write GET before that old request has drained.
    const writeBarrier = this.currentWriterState().tail
    return writeBarrier.then(() => this.issueRead(generation, signal))
  }

  /**
   * Query-friendly adapter. A late raw GET resolves to the latest accepted
   * Config rather than rolling TanStack's ['config'] cache back. Consumers that
   * need the epoch use read() or subscribe/getSnapshot instead.
   */
  async readConfig(signal?: AbortSignal): Promise<Config> {
    const receipt = await this.read(signal)
    if (shouldAcceptConfigReadReceipt(receipt, this.currentReadFence())) {
      return receipt.config
    }
    const latest = this.snapshot
    if (latest !== undefined && latest.generation === receipt.generation) {
      return latest.config
    }
    throw new ConfigReceiptGenerationError(receipt.generation, this.generation)
  }

  private issueRead(generation: number, signal?: AbortSignal): Promise<ConfigReadReceipt> {
    const issuedEpoch = ++this.issuedReadEpoch

    // Starting in a microtask converts a synchronously-thrown injected
    // transport error into a normal rejected Promise without losing the epoch.
    return Promise.resolve()
      .then(() => {
        this.assertGeneration(generation)
        return this.transport.read(signal)
      })
      .then((config) => {
        this.assertGeneration(generation)
        const receipt = Object.freeze<ConfigReadReceipt>({
          type: 'read',
          config,
          generation,
          issuedEpoch,
        })
        if (shouldAcceptConfigReadReceipt(receipt, this.currentReadFence())) {
          this.lastAcceptedReadEpoch = issuedEpoch
          this.publish(receipt)
        }
        return receipt
      })
  }

  /**
   * Enqueue one minimal ConfigPatch. Only one injected write can run at a time;
   * a rejected write is absorbed by the private tail so the next writer still
   * starts.
   */
  write(patch: ConfigPatch, signal?: AbortSignal): Promise<ConfigWriteReceipt> {
    const generation = this.generation
    const writerState = this.currentWriterState()
    const writeEpoch = ++this.issuedWriteEpoch
    const result = writerState.tail.then(() =>
      this.performWrite(patch, generation, writerState, writeEpoch, signal),
    )

    // Never let one failed PUT poison later writes in this tab.
    writerState.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async performWrite(
    patch: ConfigPatch,
    generation: number,
    writerState: ConfigWriterState,
    writeEpoch: number,
    signal?: AbortSignal,
  ): Promise<ConfigWriteReceipt> {
    this.assertGeneration(generation)
    this.assertWriteQueueAvailable(writerState)
    let config: Config
    try {
      config = await this.transport.write(patch, signal)
    } catch (error) {
      const definitive = this.options.isDefinitiveWriteError?.(error) === true
      let ambiguous: ConfigAmbiguousWriteError | undefined
      // Credential rotation fences publication but does not create a new
      // config resource. If an already-started old-token request loses its
      // response, it must still poison that resource's later writer queue.
      if (!definitive) {
        ambiguous = new ConfigAmbiguousWriteError(generation, writeEpoch, error)
        writerState.blockedWrite = { writeEpoch, error: ambiguous }
        this.notifyListeners()
      }

      this.assertGeneration(generation)
      if (definitive) throw error
      throw ambiguous
    }
    this.assertGeneration(generation)
    const ignoreReadsThroughEpoch = this.issuedReadEpoch
    this.ignoreReadsThroughEpoch = Math.max(this.ignoreReadsThroughEpoch, ignoreReadsThroughEpoch)

    // Publish the exact write receipt before the next microtask issues the
    // authoritative read. The refetch intentionally does not inherit the PUT's
    // AbortSignal: once the server has replied, reconciliation must stand on
    // its own.
    const postSettleRefetch = Promise.resolve().then(() => this.issueRead(generation))
    // The caller can await the original Promise for UI feedback. This attached
    // handler only prevents an ignored refetch failure becoming unhandled.
    void postSettleRefetch.catch(() => undefined)

    const receipt = Object.freeze<ConfigWriteReceipt>({
      type: 'write',
      config,
      generation,
      writeEpoch,
      ignoreReadsThroughEpoch,
      postSettleRefetch,
    })
    this.publish(receipt)
    return receipt
  }

  private currentReadFence(): ConfigReadFence {
    return {
      generation: this.generation,
      ignoreReadsThroughEpoch: this.ignoreReadsThroughEpoch,
      lastAcceptedReadEpoch: this.lastAcceptedReadEpoch,
    }
  }

  private assertGeneration(expectedGeneration: number): void {
    if (expectedGeneration !== this.generation) {
      throw new ConfigReceiptGenerationError(expectedGeneration, this.generation)
    }
  }

  private assertWriteQueueAvailable(writerState: ConfigWriterState): void {
    const blocked = writerState.blockedWrite
    if (blocked !== undefined) {
      throw new ConfigWriteQueueBlockedError(this.generation, blocked.writeEpoch)
    }
  }

  private currentWriterState(): ConfigWriterState {
    const state = this.writerStates.get(this.activeResourceKey)
    if (state === undefined) throw new Error('config writer state is missing for active resource')
    return state
  }

  private publish(receipt: ConfigReceipt | undefined): void {
    this.snapshot = receipt
    this.notifyListeners()
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // Receipt observers must never rewrite a successful network outcome.
      }
    }
  }
}
