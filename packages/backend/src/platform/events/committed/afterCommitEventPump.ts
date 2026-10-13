// RFC-341/RFC-349 — exact-ref post-commit projection and worker nudge.
// Projectors are awaited serially because provider-backed PostgreSQL reads are
// asynchronous and event-group order is part of the projection contract.

import { createLogger } from '@/util/log'
import type { CommittedEventCodecRegistry } from './dispatcherWorker'
import type { CommittedEventDeliveryPersistencePort } from './persistence'
import type {
  CommittedEventConsumerDefinition,
  CommittedEventEnvelopeV1,
  CommittedEventProjectionLedger,
  CommittedEventRef,
} from './types'
import { createCommittedEventProjectionLedger } from './types'

const log = createLogger('after-commit-event-pump')

export interface AfterCommitEventPump {
  publishNow(eventRefs: readonly CommittedEventRef[]): Promise<void>
  nudge(eventRefs?: readonly CommittedEventRef[]): void
}

export interface TrackedAfterCommitEventPump extends AfterCommitEventPump {
  /** Waits accepted attempts; a settled attempt does not imply projection success. */
  awaitDrained(): Promise<void>
}

export interface AfterCommitExecutionLifetime {
  current(): boolean
  readonly whenActive?: Promise<boolean>
  readonly canDispatch?: () => boolean
}

export interface ColdAfterCommitEventPump extends AfterCommitEventPump {
  start(lifetime: AfterCommitExecutionLifetime): Promise<void>
  quiesce(lifetime: AfterCommitExecutionLifetime): Promise<void>
  awaitDrained(lifetime: AfterCommitExecutionLifetime, timeoutMs?: number): Promise<void>
}

export function createAfterCommitEventPump(input: {
  readonly persistence: CommittedEventDeliveryPersistencePort
  readonly codecs: CommittedEventCodecRegistry
  readonly projectors: readonly CommittedEventConsumerDefinition[]
  readonly nudgeDispatcher: () => void
  readonly onProjectionError?: (input: {
    event: CommittedEventEnvelopeV1
    consumerId: string
    error: unknown
  }) => void
  readonly projectionLedger?: CommittedEventProjectionLedger
  readonly dedupeLimit?: number
}): TrackedAfterCommitEventPump {
  const projectors = input.projectors.filter((projector) => projector.deliveryClass === 'ephemeral')
  if (projectors.length !== input.projectors.length) {
    throw new Error('after-commit event pump accepts ephemeral projectors only')
  }
  const dedupeLimit = input.dedupeLimit ?? 2_048
  const projectionLedger =
    input.projectionLedger ?? createCommittedEventProjectionLedger(dedupeLimit)
  let projectionTail: Promise<void> = Promise.resolve()

  const nudge = (): void => {
    input.nudgeDispatcher()
  }

  const project = async (
    stored: Awaited<ReturnType<CommittedEventDeliveryPersistencePort['getStored']>>,
  ): Promise<void> => {
    const ordered = [...stored].sort((a, b) => {
      if (a.envelope.eventGroupId !== b.envelope.eventGroupId) {
        return a.envelope.eventGroupId.localeCompare(b.envelope.eventGroupId)
      }
      return a.envelope.eventGroupOrdinal - b.envelope.eventGroupOrdinal
    })
    for (const event of ordered) {
      const envelope = input.codecs.decode(event.envelope)
      for (const projector of projectors) {
        if (!projector.eventTypes.includes(envelope.type)) continue
        if (
          !projectionLedger.begin({
            eventId: envelope.eventId,
            consumerId: projector.id,
            payloadDigest: event.payloadDigest,
          })
        ) {
          continue
        }
        try {
          await projector.handle(envelope)
        } catch (error) {
          input.onProjectionError?.({ event: envelope, consumerId: projector.id, error })
          log.warn('committed event immediate projection failed', {
            eventId: envelope.eventId,
            consumerId: projector.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  return {
    async publishNow(eventRefs) {
      const dispatchable = eventRefs.filter((eventRef) => eventRef.deliveryMode === 'dispatchable')
      const ids = dispatchable.map((eventRef) => eventRef.eventId)
      const current = projectionTail.then(async () => {
        try {
          await project(await input.persistence.getStored(ids))
        } finally {
          // Durable delivery must be woken even when the immediate read or an
          // ephemeral projection fails.
          nudge()
        }
      })
      projectionTail = current.catch(() => undefined)
      await current
    },
    nudge,
    awaitDrained: () => projectionTail,
  }
}

/** Mechanism only. The owning root supplies the original lifetime and registration. */
export function createColdAfterCommitEventPump(
  input: Parameters<typeof createAfterCommitEventPump>[0],
): ColdAfterCommitEventPump {
  type Frame = {
    current: () => boolean
    dispatch: () => boolean
    tails: Set<Promise<void>>
    start: Promise<void> | null
    activated: boolean
    quiesced: boolean
    quiesceVersion: number
    selected: boolean
  }
  const identities = new WeakMap<AfterCommitExecutionLifetime, Frame>()
  // Closed frames leave this population after their actual accepted tails and
  // start attempt settle. Weak identities retain only supersession knowledge.
  const pendingFrames = new Set<Frame>()
  let lastSelected: Frame | null = null
  let active: Frame | null = null

  const retire = (frame: Frame): void => {
    if (!frame.quiesced || frame.start !== null || frame.tails.size !== 0) return
    pendingFrames.delete(frame)
    if (active === frame) active = null
  }
  const fence = (frame: Frame): void => {
    frame.quiesced = true
    frame.quiesceVersion += 1
    frame.activated = false
    if (active === frame) active = null
    retire(frame)
  }
  const admittedFrame = (): Frame | null => {
    const frame = active
    if (frame === null) return null
    // Call the captured original first, then inspect state: reentrant loss or
    // selection inside current() must also close this admission.
    if (!frame.current() || !frame.activated || frame.quiesced || active !== frame) {
      fence(frame)
      return null
    }
    if (!frame.dispatch()) return null
    return frame
  }

  // Bind the complete existing port, including its receivers. Native still
  // uses its original dynamic input lookups; only this cold path fixes them.
  const persistence: CommittedEventDeliveryPersistencePort = {
    getStored: input.persistence.getStored.bind(input.persistence),
    claimNext: input.persistence.claimNext.bind(input.persistence),
    accept: input.persistence.accept.bind(input.persistence),
    reject: input.persistence.reject.bind(input.persistence),
    retry: input.persistence.retry.bind(input.persistence),
    deliveryPage: input.persistence.deliveryPage.bind(input.persistence),
    health: input.persistence.health.bind(input.persistence),
  }
  const codecs: CommittedEventCodecRegistry = {
    eventTypes: [...input.codecs.eventTypes],
    decode: input.codecs.decode.bind(input.codecs),
  }
  const projectors = input.projectors.map(
    (projector): CommittedEventConsumerDefinition => ({
      id: projector.id,
      eventTypes: [...projector.eventTypes],
      deliveryClass: projector.deliveryClass,
      settle: projector.settle,
      handle: projector.handle.bind(projector),
    }),
  )
  const ledger =
    input.projectionLedger ?? createCommittedEventProjectionLedger(input.dedupeLimit ?? 2_048)
  const nudgeDispatcher = input.nudgeDispatcher.bind(input)
  const nudge = (): void => {
    if (admittedFrame() !== null) nudgeDispatcher()
  }
  const pump = createAfterCommitEventPump({
    persistence,
    codecs,
    projectors,
    nudgeDispatcher: nudge,
    onProjectionError: input.onProjectionError?.bind(input),
    projectionLedger: { begin: ledger.begin.bind(ledger) },
  })

  const waitActual = (tails: readonly Promise<void>[], timeoutMs: number): Promise<void> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error('after-commit execution drain budget must be a positive integer'),
      )
    }
    if (tails.length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('after-commit execution actual drain timed out'))
      }, timeoutMs)
      void Promise.all(tails).then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  const start = (lifetime: AfterCommitExecutionLifetime): Promise<void> => {
    let frame = identities.get(lifetime)
    if (frame === undefined) {
      frame = {
        current: lifetime.current.bind(lifetime),
        dispatch: lifetime.canDispatch?.bind(lifetime) ?? (() => true),
        tails: new Set(),
        start: null,
        activated: false,
        quiesced: false,
        quiesceVersion: 0,
        selected: false,
      }
      identities.set(lifetime, frame)
    }
    if (frame.selected && lastSelected !== frame) {
      return Promise.reject(new Error('after-commit execution lifetime has been superseded'))
    }
    if (frame.start !== null) return frame.start
    try {
      const previous = lastSelected
      const quiesceVersion = frame.quiesceVersion
      const current = frame.current()
      if (!current) {
        fence(frame)
        return Promise.reject(new Error('after-commit execution lifetime is not current'))
      }
      if (lastSelected !== previous || frame.quiesceVersion !== quiesceVersion) {
        fence(frame)
        return Promise.reject(new Error('after-commit execution start quiesced'))
      }
      if (frame.activated && !frame.quiesced && active === frame) return Promise.resolve()
      lastSelected = frame
      frame.selected = true
      frame.quiesced = false
      frame.activated = false
      active = null
      pendingFrames.add(frame)
      for (const prior of pendingFrames) {
        if (prior !== frame) fence(prior)
      }
      // Wait actual accepted work, never another frame's start promise. A
      // superseding B cannot turn A's wait into a reverse A <-> B dependency.
      const tails = [...new Set([...pendingFrames].flatMap((prior) => [...prior.tails]))]
      const selected = frame
      const pending = (async () => {
        await waitActual(tails, 10_000)
        if (!selected.current() || selected.quiesced || lastSelected !== selected) {
          throw new Error('after-commit execution start quiesced')
        }
        selected.activated = true
        active = selected
      })()
        .catch((error: unknown) => {
          fence(selected)
          throw error
        })
        .finally(() => {
          if (selected.start === pending) selected.start = null
          retire(selected)
        })
      frame.start = pending
      return pending
    } catch (error) {
      fence(frame)
      return Promise.reject(error)
    }
  }

  return {
    start,
    async publishNow(eventRefs) {
      const frame = admittedFrame()
      if (frame === null) throw new Error('after-commit execution is not ready')
      // Register the admitted attempt before the original synchronous ref
      // filtering. Reentrant loss must see its tail even before the first await.
      let settle!: () => void
      const tail = new Promise<void>((resolve) => {
        settle = resolve
      })
      frame.tails.add(tail)
      try {
        await pump.publishNow(eventRefs)
      } finally {
        // An actual original completion, including rejection, settles the
        // attempt. The original error still propagates to its publish caller.
        settle()
        frame.tails.delete(tail)
        retire(frame)
      }
    },
    nudge,
    quiesce(lifetime) {
      const frame = identities.get(lifetime)
      if (frame !== undefined) fence(frame)
      return Promise.resolve()
    },
    awaitDrained(lifetime, timeoutMs = 10_000) {
      const frame = identities.get(lifetime)
      if (frame === undefined) return Promise.resolve()
      if (!frame.quiesced) {
        return Promise.reject(new Error('after-commit execution drain requires quiesce'))
      }
      const tails = [...frame.tails]
      if (frame.start !== null) tails.push(frame.start.catch(() => undefined))
      return waitActual(tails, timeoutMs)
    },
  }
}
