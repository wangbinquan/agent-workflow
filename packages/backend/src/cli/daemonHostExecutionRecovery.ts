import { sha256Hex } from '@/util/hash'
import {
  runTaskExecutionBootRecovery,
  type TaskExecutionBootRecoveryInput,
} from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import type {
  HostExecutionGrantContext,
  HostExecutionRecoveryFamily,
} from '@/modules/system-operations/public/participants'
import type { DaemonProviderHostExecutionHandleBinding } from './daemonProviderRuntimeSession'
import { IntentOriginalExecutionPendingError } from '@/modules/intent/composition/execution'
import {
  IndeterminateRuntimeProcessError,
  MemoryDistillSettlementPendingError,
} from '@/modules/memory/composition'

/** Retire a failed preparation only after its actual retained owner confirms
 * the original physical/business tail; never rerun preparation effects here. */
export async function awaitOriginalHostPreparation(pending: Promise<unknown>): Promise<void> {
  try {
    await pending
  } catch (error) {
    if (
      (error instanceof IntentOriginalExecutionPendingError ||
        error instanceof IndeterminateRuntimeProcessError) &&
      error.originalRecoveryAcknowledged()
    )
      return
    if (
      error instanceof MemoryDistillSettlementPendingError &&
      error.originalSettlementAcknowledged()
    )
      return
    throw error
  }
}

class PreparationUnavailable extends Error {}

/** Real original four-step recovery, performed only under this root's grant.
 * Owner initialization callbacks are captured by the root while composing its
 * graph and preserve their original order and receivers. */
export interface DaemonHostRecoveryCompositionInput {
  readonly generation: string
  readonly boot?: TaskExecutionBootRecoveryInput
  /** Embedded HTTP retains its original per-Task ownership, without a PID proof. */
  readonly taskPersistence?: TaskExecutionBootRecoveryInput['persistence']
  readonly resourceReady?: Promise<void>
  readonly handles: readonly DaemonProviderHostExecutionHandleBinding[]
  readonly prepareOwners?: readonly ((context: HostExecutionGrantContext) => Promise<void>)[]
}

export function composeDaemonLocalHostRecovery(
  input: DaemonHostRecoveryCompositionInput,
): HostExecutionRecoveryFamily {
  const boot = input.boot
  if (!boot) throw new Error('daemon-host-original-boot-recovery-missing')
  const original = selectLocalBootExecutionRecoveryFactory(boot.recoveryEffects)
  const prepareOwners = [...(input.prepareOwners ?? [])]
  const groups = Object.freeze([...new Set(input.handles.map((handle) => handle.group))])
  const frames = new WeakMap<
    HostExecutionGrantContext,
    {
      quiesced: boolean
      current: () => boolean
      pending: Promise<unknown>
    }
  >()
  const requireFrame = (context: HostExecutionGrantContext) => {
    const frame = frames.get(context)
    if (!frame) throw new Error('daemon-host-recovery-lifetime-missing')
    return frame
  }
  return Object.freeze({
    kind: 'local-startup',
    prepare(context) {
      if (context.generation !== input.generation || frames.has(context))
        throw new Error('daemon-host-recovery-generation-mismatch')
      const capturedCurrent = context.current.bind(context)
      const frame = {
        quiesced: false,
        current: () => !frame.quiesced && capturedCurrent(),
        pending: Promise.resolve<unknown>(undefined),
      }
      frames.set(context, frame)
      const requireCurrent = () => {
        if (!frame.current()) throw new PreparationUnavailable('daemon-host-recovery-quiesced')
      }
      const recoveryEffects: NonNullable<TaskExecutionBootRecoveryInput['recoveryEffects']> = {
        create(boot) {
          const family = original.create(boot)
          return {
            prepare() {
              requireCurrent()
              return family.prepare()
            },
            reap() {
              requireCurrent()
              return family.reap()
            },
            repair(ref) {
              requireCurrent()
              return family.repair(ref)
            },
            finalize(ref) {
              requireCurrent()
              return family.finalize(ref)
            },
          }
        },
      }
      const preparing = Promise.resolve().then(async () => {
        try {
          requireCurrent()
          const report = await runTaskExecutionBootRecovery({
            ...boot,
            recoveryGrant: context,
            recoveryEffects,
          })
          for (const prepare of prepareOwners) {
            requireCurrent()
            await prepare(context)
          }
          requireCurrent()
          return {
            kind: 'prepared' as const,
            preparationDigest: sha256Hex(
              JSON.stringify([input.generation, report, input.handles.map((handle) => handle.id)]),
            ),
            // Local in-process Task intents have no negotiated remote payload
            // version. A durable-intent host supplies its own recovery family.
            acceptedTaskContractVersions: Object.freeze([] as string[]),
            readyGroups: groups,
          }
        } catch (error) {
          if (error instanceof PreparationUnavailable)
            return { kind: 'deferred' as const, reason: error.message }
          throw error
        }
      })
      frame.pending = preparing
      void preparing.catch(() => {})
      return preparing
    },
    quiesce({ context }) {
      requireFrame(context).quiesced = true
    },
    async drain(context) {
      const frame = requireFrame(context)
      if (!frame.quiesced) throw new Error('daemon-host-recovery-drain-before-quiesce')
      // Preserve a failed recovery as an unsettled control result. Drain must
      // not acknowledge a successful retirement or rerun any recovery effect.
      await awaitOriginalHostPreparation(frame.pending)
    },
  } satisfies HostExecutionRecoveryFamily)
}
