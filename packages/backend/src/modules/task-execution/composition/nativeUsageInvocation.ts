import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import type { NativeUsageInvocationPersistence } from '../application/ports/nativeUsageInvocation'
import { DrizzleNativeUsagePages } from '../infrastructure/drizzleNativeUsagePages'
import { DrizzleNativeUsageEmission } from '../infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '../infrastructure/drizzleNativeUsageCompletion'
import {
  originalNativeUsageBaseline,
  withNativeUsageBaselineSnapshot,
} from '../infrastructure/nativeUsageBaselineSnapshot'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import type {
  ObservationNativeCompletion,
  ObservationNativeSourceAck,
  ObservationNativeBeforeSpawnAck,
} from '@agent-workflow/shared'

/** No caller-created claim or alternate usage ledger: all callbacks retain this exact owner. */
export function createNativeUsageInvocationPersistence(
  db: ProviderNeutralDatabase,
  options: { readonly baselineSnapshots?: ReportSnapshotSession } = {},
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
      const passOwner = (
        before: ObservationNativeBeforeSpawnAck,
        writer = pages,
      ): ReturnType<
        NonNullable<ReturnType<NativeUsageInvocationPersistence['forInvocation']>>['passOwner']
      > => ({
        admit: (identity, initialCursor, rootCreatedAt) =>
          writer.admit({
            binding,
            identity,
            initialCursor,
            rootCreatedAt,
            beforeSpawnReceiptId: before.ownerReceiptId,
          }),
        persist: (page) =>
          writer.persist({
            binding,
            page: {
              ...page,
              sessions: [...page.sessions],
              steps: [...page.steps],
              issues: [...page.issues],
            },
          }),
        interrupt: (identity, reason) => writer.interrupt({ binding, identity, reason }),
      })
      return {
        prepare: (request) => pages.prepare({ binding, ...request }),
        passOwner,
        async withFinalOwner(before, read) {
          // Only the platform can supply an independent original read channel.
          // The original single-connection memory/PG path keeps its per-page verification.
          if (!options.baselineSnapshots || before.mode !== 'resume') return read(passOwner(before))
          const original = await originalNativeUsageBaseline({ db, binding, before })
          if (!original) return read(passOwner(before, new DrizzleNativeUsagePages(db, true, null)))
          return withNativeUsageBaselineSnapshot({
            snapshots: options.baselineSnapshots,
            binding,
            original,
            run: (baseline) =>
              read(passOwner(before, new DrizzleNativeUsagePages(db, true, baseline))),
          })
        },
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
