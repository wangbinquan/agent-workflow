// RFC-201 — single-daemon linearization boundary for resource mutations and
// long-running exact-revision operations. The coordinator is intentionally
// storage-agnostic: routes/services reload and authorize while holding the
// stable-id lock, then may release it for external I/O and reacquire to settle.

interface LockState {
  tail: Promise<void>
  pending: number
}

export interface OperationGeneration {
  generation: number
  startedAt: number
}

export class ResourceOperationCoordinator {
  private readonly locks = new Map<string, LockState>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly activeOperationCounts = new Map<string, number>()
  private readonly generations = new Map<string, number>()
  private readonly latestGenerations = new Map<string, number>()
  private readonly logicalClocks = new Map<string, number>()
  private readonly lastOperationStartedAt = new Map<string, number>()

  /** Serialize a short critical section by immutable resource id. */
  async runExclusive<T>(resourceId: string, task: () => Promise<T> | T): Promise<T> {
    let state = this.locks.get(resourceId)
    if (state === undefined) {
      state = { tail: Promise.resolve(), pending: 0 }
      this.locks.set(resourceId, state)
    }

    const previous = state.tail
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    state.tail = previous.then(() => turn)
    state.pending += 1

    await previous
    try {
      return await task()
    } finally {
      state.pending -= 1
      release()
      if (state.pending === 0 && this.locks.get(resourceId) === state) {
        this.locks.delete(resourceId)
        this.cleanupIdleResource(resourceId)
      }
    }
  }

  /**
   * Join the complete start→I/O→finalize promise for one exact saved revision.
   * The entry is installed synchronously before the factory begins and removed
   * only after settle, so same-hash callers cannot duplicate external I/O.
   */
  runDeduplicatedOperation<T>(
    resourceId: string,
    operationConfigHash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([resourceId, operationConfigHash])
    const existing = this.operations.get(key)
    if (existing !== undefined) return existing as Promise<T>

    this.activeOperationCounts.set(
      resourceId,
      (this.activeOperationCounts.get(resourceId) ?? 0) + 1,
    )
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.operations.get(key) === promise) this.operations.delete(key)
        const remaining = (this.activeOperationCounts.get(resourceId) ?? 1) - 1
        if (remaining === 0) this.activeOperationCounts.delete(resourceId)
        else this.activeOperationCounts.set(resourceId, remaining)
        this.cleanupIdleResource(resourceId)
      })
    this.operations.set(key, promise)
    return promise
  }

  /** Must be called while holding this resource's exclusive section. */
  beginOperation(
    resourceId: string,
    now: number,
    timestampFloors: readonly number[],
  ): OperationGeneration {
    const generation = (this.generations.get(resourceId) ?? 0) + 1
    this.generations.set(resourceId, generation)
    this.latestGenerations.set(resourceId, generation)
    const startedAt = this.nextCausalTimestamp(resourceId, now, timestampFloors)
    this.lastOperationStartedAt.set(resourceId, startedAt)
    return { generation, startedAt }
  }

  latestGeneration(resourceId: string): number {
    return this.latestGenerations.get(resourceId) ?? 0
  }

  activeLastStartedAt(resourceId: string): number {
    return this.lastOperationStartedAt.get(resourceId) ?? 0
  }

  /**
   * Per-id logical wall clock. Callers pass persisted floors (+1 already
   * applied); the coordinator adds its own prior+1 fence for same-ms ordering.
   */
  nextCausalTimestamp(resourceId: string, now: number, timestampFloors: readonly number[]): number {
    const previous = this.logicalClocks.get(resourceId) ?? 0
    const next = Math.max(now, previous + 1, ...timestampFloors)
    this.logicalClocks.set(resourceId, next)
    return next
  }

  /** White-box diagnostics used only by deterministic tests. */
  __state(): { locks: number; operations: number } {
    return { locks: this.locks.size, operations: this.operations.size }
  }

  private cleanupIdleResource(resourceId: string): void {
    if (this.locks.has(resourceId) || (this.activeOperationCounts.get(resourceId) ?? 0) > 0) return
    // Persisted MCP/resource timestamps carry cross-operation and cross-daemon
    // causality. These in-memory counters only need to live while work for the
    // id is active, avoiding an unbounded map for deleted resources.
    this.generations.delete(resourceId)
    this.latestGenerations.delete(resourceId)
    this.logicalClocks.delete(resourceId)
    this.lastOperationStartedAt.delete(resourceId)
  }
}

/** Shared single-daemon instances, keyed by resource family then stable id. */
export const mcpOperationCoordinator = new ResourceOperationCoordinator()
export const pluginOperationCoordinator = new ResourceOperationCoordinator()
