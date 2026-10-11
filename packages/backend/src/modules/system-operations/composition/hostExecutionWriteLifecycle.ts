import type {
  HostExecutionGrantContext,
  HostExecutionWriteLifecycle,
} from '../application/ports/hostExecutionAuthority'
import type {
  HostExecutionWriteContext,
  HostExecutionWriteLeaseFacts,
  HostExecutionWriteReceipt,
} from '../application/ports/hostExecutionWriteContext'

interface WritePreparationProgress {
  readonly current: () => boolean
  prepareAttempted: boolean
  holder?: string
  receipt?: HostExecutionWriteReceipt
  prepareFailure?: { readonly error: unknown }
}

/** Preserve the original callbacks, receivers, grant and actual durable receipt. */
export function composeHostExecutionWriteLifecycle(input: {
  readonly context: HostExecutionWriteContext
  readonly facts: HostExecutionWriteLeaseFacts
}): HostExecutionWriteLifecycle {
  const context = input.context
  const facts = input.facts
  for (const method of ['prepare', 'activate', 'renew', 'drain', 'retire'] as const) {
    if (typeof context?.[method] !== 'function') {
      throw new Error(`host-execution-write-context-missing-${method}`)
    }
  }
  if (typeof facts?.forGrant !== 'function') {
    throw new Error('host-execution-write-lease-facts-missing-forGrant')
  }
  const prepare = context.prepare,
    activate = context.activate,
    renew = context.renew,
    drain = context.drain,
    retire = context.retire,
    forGrant = facts.forGrant
  const progress = new WeakMap<HostExecutionGrantContext, WritePreparationProgress>()

  const receiptFor = (grant: HostExecutionGrantContext): HostExecutionWriteReceipt => {
    const prepared = progress.get(grant)
    if (prepared?.receipt !== undefined) return prepared.receipt
    if (prepared?.prepareFailure !== undefined) throw prepared.prepareFailure.error
    throw new Error('host-execution-write-preparation-unsettled')
  }

  return Object.freeze<HostExecutionWriteLifecycle>({
    async prepare(grant) {
      if (progress.has(grant)) throw new Error('host-execution-write-preparation-already-attempted')
      const current = grant.current
      const prepared: WritePreparationProgress = {
        current: () => current.call(grant),
        prepareAttempted: false,
      }
      progress.set(grant, prepared)
      const lease = await forGrant.call(facts, grant)
      if (!prepared.current()) return
      const holder = lease.holder,
        expiresAt = lease.expiresAt
      prepared.holder = holder
      prepared.prepareAttempted = true
      try {
        prepared.receipt = await prepare.call(context, { context: grant, holder, expiresAt })
      } catch (error) {
        // Rejection after invocation may mean an unknown durable commit. Keep it
        // unsettled; absence of an in-memory receipt is not a retirement ACK.
        prepared.prepareFailure = { error }
        throw error
      }
    },
    async activate(grant) {
      await activate.call(context, receiptFor(grant))
    },
    async renew(grant) {
      const receipt = receiptFor(grant)
      const prepared = progress.get(grant)!
      const lease = await forGrant.call(facts, grant)
      if (!prepared.current()) return
      const holder = lease.holder,
        expiresAt = lease.expiresAt
      if (holder !== prepared.holder) {
        throw new Error('host-execution-write-lease-holder-mismatch')
      }
      await renew.call(context, receipt, expiresAt)
    },
    async quiesce(grant) {
      if (!progress.get(grant)?.prepareAttempted) return
      await drain.call(context, receiptFor(grant))
    },
    async retire(grant) {
      if (!progress.get(grant)?.prepareAttempted) return
      await retire.call(context, receiptFor(grant))
    },
  })
}
