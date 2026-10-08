import type {
  HostExecutionAdmissionLease,
  HostExecutionAdmission,
  HostExecutionAuthorityDriver,
  HostExecutionAuthorityLifecycle,
  HostExecutionAuthorityObservation,
  HostExecutionAuthorityReference,
  HostExecutionGrantContext,
  HostExecutionGroup,
  HostExecutionPhase,
  HostExecutionRecoveryFamily,
  HostExecutionRuntimeFamily,
  HostExecutionStopReason,
} from './ports/hostExecutionAuthority'

interface AdmissionProgress {
  readonly completed: Promise<void>
  readonly stop: (reason: HostExecutionStopReason) => void
}

interface GrantProgress {
  readonly reference: HostExecutionAuthorityReference
  readonly version: number
  readonly context: HostExecutionGrantContext
  readonly admissions: Set<AdmissionProgress>
  valid: boolean
  reason: HostExecutionStopReason
  preparationAttempted: boolean
  startAttempted: boolean
  recoveryQuiesced: boolean
  recoveryDrained: boolean
  runtimeQuiesced: boolean
  runtimeDrained: boolean
  driverQuiesced: boolean
  released: boolean
}

export interface CreateHostExecutionAuthorityLifecycleInput {
  readonly generation: string
  readonly mode: 'resource-only' | 'execution'
  readonly driver: HostExecutionAuthorityDriver
  readonly recovery: HostExecutionRecoveryFamily
  readonly runtime: HostExecutionRuntimeFamily
  readonly onFailure: (error: unknown) => void
}

function assertComplete(input: CreateHostExecutionAuthorityLifecycleInput): void {
  if (input.mode !== 'resource-only' && input.mode !== 'execution') {
    throw new Error('host-execution-mode-missing')
  }
  if (typeof input.onFailure !== 'function') {
    throw new Error('host-execution-failure-receiver-missing')
  }
  for (const name of ['claim', 'renew', 'activate', 'quiesce', 'release', 'subscribe'] as const) {
    if (typeof input.driver[name] !== 'function') {
      throw new Error(`host-execution-authority-missing-${name}`)
    }
  }
  if (!['local-startup', 'durable-intent'].includes(input.recovery.kind)) {
    throw new Error('host-execution-recovery-kind-missing')
  }
  for (const name of ['prepare', 'quiesce', 'drain'] as const) {
    if (typeof input.recovery[name] !== 'function') {
      throw new Error(`host-execution-recovery-missing-${name}`)
    }
  }
  for (const name of ['start', 'quiesce', 'drain'] as const) {
    if (typeof input.runtime[name] !== 'function') {
      throw new Error(`host-execution-runtime-missing-${name}`)
    }
  }
}

/** Own one provider generation's admission, control ACKs and grant retirement. */
export function createHostExecutionAuthorityLifecycle(
  input: CreateHostExecutionAuthorityLifecycleInput,
): HostExecutionAuthorityLifecycle {
  assertComplete(input)
  let phase: HostExecutionPhase = 'standby'
  let reason: string | null =
    input.mode === 'resource-only' ? 'host-execution-resource-only' : 'host-execution-unclaimed'
  let readyGroups: readonly HostExecutionGroup[] = Object.freeze([])
  let version = 0
  let closing = false
  let current: GrantProgress | undefined
  let desired: GrantProgress | undefined
  let subscription: { close(): void | Promise<void> } | undefined
  let subscriptionClosed = false
  let subscriptionClose: Promise<void> | undefined
  let tail: Promise<void> = Promise.resolve()
  let lastFailure: { readonly error: unknown } | undefined
  const grants = new WeakMap<HostExecutionAuthorityReference, GrantProgress>()
  const ownedGrants = new Set<GrantProgress>()
  const pendingControls = new Set<Promise<unknown>>()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const notifyFailure = (error: unknown): void => {
    lastFailure = { error }
    try {
      input.onFailure(error)
    } catch (listenerError) {
      lastFailure = {
        error: new AggregateError([error, listenerError], 'host execution failure listener failed'),
      }
    }
  }

  const register = (
    reference: HostExecutionAuthorityReference,
    operationVersion: number,
  ): GrantProgress => {
    if (reference === null || typeof reference !== 'object') {
      throw new Error('host-execution-grant-reference-missing')
    }
    const known = grants.get(reference)
    if (known) return known
    const progress: GrantProgress = {
      reference,
      version: operationVersion,
      context: Object.freeze({
        generation: input.generation,
        reference,
        current: () => !closing && progress.valid && progress.version === version,
      }),
      admissions: new Set(),
      valid: !closing && operationVersion === version,
      reason: closing ? 'shutdown' : 'authority-loss',
      preparationAttempted: false,
      startAttempted: false,
      recoveryQuiesced: true,
      recoveryDrained: true,
      runtimeQuiesced: true,
      runtimeDrained: true,
      driverQuiesced: false,
      released: false,
    }
    grants.set(reference, progress)
    ownedGrants.add(progress)
    return progress
  }

  const invalidate = (stopReason: HostExecutionStopReason, unavailableReason: string): void => {
    version += 1
    readyGroups = Object.freeze([])
    reason = unavailableReason
    for (const grant of ownedGrants) {
      if (!grant.valid) continue
      grant.valid = false
      grant.reason = stopReason
      for (const admitted of grant.admissions) admitted.stop(stopReason)
    }
    current = undefined
    desired = undefined
    if (phase !== 'closed') phase = ownedGrants.size ? 'draining' : 'standby'
  }

  const control = async (
    operationVersion: number,
    invoke: () => HostExecutionAuthorityObservation | Promise<HostExecutionAuthorityObservation>,
  ): Promise<HostExecutionAuthorityObservation> => {
    // Register before invoking the driver, including its synchronous callbacks.
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    pendingControls.add(pending)
    try {
      const result = await invoke()
      if (result.kind === 'granted') register(result.reference, operationVersion)
      return result
    } finally {
      pendingControls.delete(pending)
      finish()
    }
  }

  const beginSubscriptionClose = (): void => {
    if (!subscription || subscriptionClosed || subscriptionClose) return
    const exact = subscription
    // Invoke now, even when a pending claim/renew/activate occupies the queue.
    // Its ACK remains owned by close(); rejection is recorded for that owner.
    subscriptionClose = Promise.resolve()
      .then(() => exact.close())
      .then(() => {
        subscriptionClosed = true
      })
    subscriptionClose.catch(() => {})
  }

  const retire = async (grant: GrantProgress): Promise<void> => {
    if (grant.valid || grant.released) return
    const failures: unknown[] = []
    const attempt = async (operation: () => void | Promise<void>, ack: () => void) => {
      try {
        await operation()
        ack()
      } catch (error) {
        failures.push(error)
      }
    }
    if (!grant.driverQuiesced) {
      await attempt(
        () => input.driver.quiesce({ reference: grant.reference, reason: grant.reason }),
        () => {
          grant.driverQuiesced = true
        },
      )
    }
    if (!grant.runtimeQuiesced) {
      await attempt(
        () => input.runtime.quiesce({ context: grant.context, reason: grant.reason }),
        () => {
          grant.runtimeQuiesced = true
        },
      )
    }
    if (!grant.recoveryQuiesced) {
      await attempt(
        () => input.recovery.quiesce({ context: grant.context, reason: grant.reason }),
        () => {
          grant.recoveryQuiesced = true
        },
      )
    }
    if (grant.runtimeQuiesced && !grant.runtimeDrained) {
      await attempt(
        () => input.runtime.drain(grant.context),
        () => {
          grant.runtimeDrained = true
        },
      )
    }
    if (grant.recoveryQuiesced && !grant.recoveryDrained) {
      await attempt(
        () => input.recovery.drain(grant.context),
        () => {
          grant.recoveryDrained = true
        },
      )
    }
    if (
      grant.driverQuiesced &&
      grant.runtimeQuiesced &&
      grant.recoveryQuiesced &&
      grant.runtimeDrained &&
      grant.recoveryDrained
    ) {
      await Promise.all([...grant.admissions].map((entry) => entry.completed))
      await attempt(
        () => input.driver.release(grant.reference),
        () => {
          grant.released = true
          ownedGrants.delete(grant)
        },
      )
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'failed to retire host execution grant')
    }
  }

  const retireObsolete = async (): Promise<void> => {
    await Promise.all([...pendingControls])
    for (const grant of ownedGrants) await retire(grant)
    if (!closing && !current) phase = 'standby'
  }

  const adopt = async (grant: GrantProgress): Promise<void> => {
    await retireObsolete()
    if (!grant.context.current() || grant.startAttempted) return
    current = grant
    phase = 'preparing'
    reason = 'host-execution-preparing'
    grant.preparationAttempted = true
    grant.recoveryQuiesced = false
    grant.recoveryDrained = false
    let failed = false
    try {
      const prepared = await input.recovery.prepare(grant.context)
      if (!grant.context.current()) return
      if (prepared.kind === 'deferred' || prepared.readyGroups.length === 0) {
        invalidate(
          'authority-loss',
          prepared.kind === 'deferred' ? prepared.reason : 'host-execution-no-ready-groups',
        )
        return
      }
      const activated = await control(grant.version, () =>
        input.driver.activate({
          reference: grant.reference,
          preparationDigest: prepared.preparationDigest,
          acceptedTaskContractVersions: prepared.acceptedTaskContractVersions,
        }),
      )
      if (!grant.context.current()) return
      if (activated.kind !== 'granted') {
        invalidate('authority-loss', activated.reason)
        return
      }
      if (activated.reference !== grant.reference) {
        throw new Error('host-execution-activation-reference-mismatch')
      }
      grant.startAttempted = true
      grant.runtimeQuiesced = false
      grant.runtimeDrained = false
      await input.runtime.start({ context: grant.context, groups: prepared.readyGroups })
      if (!grant.context.current()) return
      readyGroups = Object.freeze([...new Set(prepared.readyGroups)])
      phase = 'active'
      reason = null
      lastFailure = undefined
    } catch (error) {
      failed = true
      if (grant.context.current()) invalidate('authority-loss', 'host-execution-activation-failed')
      try {
        await retireObsolete()
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          'failed to activate and retire host execution grant',
        )
      }
      throw error
    } finally {
      if (!failed && !grant.context.current()) await retireObsolete()
    }
  }

  const observe = (observation: HostExecutionAuthorityObservation): void => {
    if (observation.kind !== 'granted') {
      invalidate('authority-loss', observation.reason)
      serialize(retireObsolete).catch(notifyFailure)
      return
    }
    if (current?.reference === observation.reference && current.context.current()) return
    const known = grants.get(observation.reference)
    if (known?.context.current()) return
    if (known && !known.context.current()) {
      serialize(retireObsolete).catch(notifyFailure)
      return
    }
    // A fresh observation supersedes both a preparing/queued grant and a
    // pending control result, even before the first runtime has started.
    invalidate('authority-loss', 'host-execution-grant-replaced')
    const grant = register(observation.reference, version)
    desired = grant
    serialize(() => adopt(grant)).catch(notifyFailure)
  }

  const lifecycle: HostExecutionAuthorityLifecycle = {
    queries: Object.freeze({
      snapshot: () => Object.freeze({ phase, generation: input.generation, readyGroups, reason }),
    }),
    admission: Object.freeze<HostExecutionAdmission>({
      acquire(group) {
        const grant = current
        if (phase !== 'active' || !grant?.context.current() || !readyGroups.includes(group)) {
          return {
            kind: 'unavailable',
            reason: reason ?? `host-execution-group-unavailable:${group}`,
          }
        }
        let finish!: () => void
        let stop!: (value: HostExecutionStopReason) => void
        const progress: AdmissionProgress = {
          completed: new Promise<void>((resolve) => {
            finish = resolve
          }),
          stop: (value) => stop(value),
        }
        const lease: HostExecutionAdmissionLease = Object.freeze({
          generation: input.generation,
          reference: grant.reference,
          stopped: new Promise<HostExecutionStopReason>((resolve) => {
            stop = resolve
          }),
          complete() {
            grant.admissions.delete(progress)
            finish()
          },
        })
        grant.admissions.add(progress)
        return { kind: 'admitted', lease }
      },
    }),
    start() {
      return serialize(async () => {
        if (closing) throw new Error('host-execution-closed')
        if (input.mode === 'resource-only' || current?.context.current()) return
        try {
          await retireObsolete()
          const operationVersion = version
          if (!subscription) {
            subscription = await input.driver.subscribe({
              onObservation: observe,
              onFailure(error) {
                invalidate('authority-loss', 'host-execution-driver-failed')
                serialize(retireObsolete).catch(notifyFailure)
                notifyFailure(error)
              },
            })
            if (closing) beginSubscriptionClose()
          }
          if (closing) return
          if (desired?.context.current()) {
            await adopt(desired)
            return
          }
          if (operationVersion !== version) return
          const observation = await control(operationVersion, () => input.driver.claim())
          if (observation.kind === 'granted') {
            await adopt(register(observation.reference, operationVersion))
          } else if (operationVersion === version && !closing) {
            invalidate('authority-loss', observation.reason)
          }
          await retireObsolete()
        } catch (error) {
          invalidate('authority-loss', 'host-execution-start-failed')
          try {
            await retireObsolete()
          } catch (retirementError) {
            throw new AggregateError(
              [error, retirementError],
              'failed to start and retire host execution grant',
            )
          }
          throw error
        }
      })
    },
    renew() {
      return serialize(async () => {
        const grant = current
        if (closing || !grant?.context.current()) return
        try {
          const observation = await control(grant.version, () =>
            input.driver.renew(grant.reference),
          )
          if (grant.context.current()) {
            if (observation.kind === 'granted' && observation.reference !== grant.reference) {
              invalidate('authority-loss', 'host-execution-renewal-reference-mismatch')
            } else {
              observe(observation)
            }
          }
          await retireObsolete()
        } catch (error) {
          if (grant.context.current()) invalidate('authority-loss', 'host-execution-renewal-failed')
          try {
            await retireObsolete()
          } catch (retirementError) {
            throw new AggregateError(
              [error, retirementError],
              'failed to renew and retire host execution grant',
            )
          }
          throw error
        }
      })
    },
    async settled() {
      let awaited: Promise<void>
      do {
        awaited = tail
        await awaited
      } while (awaited !== tail)
      if (lastFailure !== undefined) throw lastFailure.error
    },
    close() {
      if (!closing) {
        closing = true
        invalidate('shutdown', 'host-execution-closed')
      }
      beginSubscriptionClose()
      return serialize(async () => {
        if (phase === 'closed') return
        phase = 'draining'
        beginSubscriptionClose()
        await retireObsolete()
        if (subscriptionClose) {
          try {
            await subscriptionClose
          } catch (error) {
            subscriptionClose = undefined
            throw error
          }
        }
        // An observation can yield a late grant while subscription.close is
        // settling. Its ACK is part of this close, not a later queued cleanup.
        await retireObsolete()
        phase = 'closed'
        reason = 'host-execution-closed'
        lastFailure = undefined
      })
    },
  }
  return Object.freeze(lifecycle)
}
