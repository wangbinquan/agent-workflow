import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import type { NativeUsageInvocationPersistence } from '../application/ports/nativeUsageInvocation'
import { DrizzleNativeUsagePages } from '../infrastructure/drizzleNativeUsagePages'
import { DrizzleNativeUsageEmission } from '../infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '../infrastructure/drizzleNativeUsageCompletion'
import type {
  ObservationNativeCompletion,
  ObservationNativeSourceAck,
} from '@agent-workflow/shared'

/** No caller-created claim or alternate usage ledger: all callbacks retain this exact owner. */
export function createNativeUsageInvocationPersistence(
  db: ProviderNeutralDatabase,
): NativeUsageInvocationPersistence {
  return {
    forInvocation(input) {
      const executionContext = currentTaskExecutionContext(input.taskId)
      if (!executionContext) return undefined
      const binding = { ...input, executionContext }
      const pages = new DrizzleNativeUsagePages(db, true)
      const emissions = new DrizzleNativeUsageEmission(db)
      const completion = new DrizzleNativeUsageCompletion(db)
      let retryProof: ObservationNativeCompletion | undefined
      let completeAck: ObservationNativeSourceAck | undefined
      return {
        prepare: (request) => pages.prepare({ binding, ...request }),
        passOwner: (before) => ({
          admit: (identity, initialCursor, rootCreatedAt) =>
            pages.admit({
              binding,
              identity,
              initialCursor,
              rootCreatedAt,
              beforeSpawnReceiptId: before.ownerReceiptId,
            }),
          persist: (page) => pages.persist({ binding, page }),
          interrupt: (identity, reason) => pages.interrupt({ binding, identity, reason }),
        }),
        recordProcess: (nativeProcess) =>
          emissions.emit({
            binding,
            eventId: 'native-process:' + sha256Hex(JSON.stringify(nativeProcess)),
            evidence: {
              invocationId: binding.invocationId,
              measurements: [],
              diagnostics: [],
              nativeProcess,
            },
          }),
        async seal(observedAt) {
          if (completeAck) return completeAck
          const proof = retryProof ?? (await completion.describeCompletion({ binding, observedAt }))
          retryProof = proof
          const ack = await completion.seal({ binding, completion: proof })
          retryProof = undefined
          if (proof.state === 'complete') completeAck = ack
          return ack
        },
      }
    },
  }
}
