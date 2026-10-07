import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { isRuntimeNativeUsageCaptureEligible } from '@/modules/runtime-management/public/queries'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import type {
  NativeUsageAdmission,
  NativeUsageInvocationPersistence,
} from '../application/ports/nativeUsageInvocation'
import type { NativeUsageBaselineReadSession } from '../application/ports/nativeUsageBaseline'
import { DrizzleNativeUsagePages } from '../infrastructure/drizzleNativeUsagePages'
import { DrizzleNativeUsageEmission } from '../infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '../infrastructure/drizzleNativeUsageCompletion'
import { createNativeUsageFinalizationAuthority } from '../infrastructure/nativeUsageFinalizationAuthority'
import {
  DrizzleNativeUsageRootCompletion,
  NativeRootCompletionCandidateChanged,
} from '../infrastructure/drizzleNativeUsageRootCompletion'
import { createNativeUsageRootCollection } from '../infrastructure/nativeUsageRootCollection'
import {
  originalNativeUsageBaseline,
  withNativeUsageBaselineSnapshot,
} from '../infrastructure/nativeUsageBaselineSnapshot'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import type {
  ObservationAnyNativeCompletion,
  ObservationNativeSourceAck,
  ObservationNativeBeforeSpawnAck,
} from '@agent-workflow/shared'

/** No caller-created claim or alternate usage ledger: all callbacks retain this exact owner. */
export function createNativeUsageInvocationPersistence(
  db: ProviderNeutralDatabase,
  options: {
    readonly baselineSnapshots?: ReportSnapshotSession
    readonly baselineRead?: NativeUsageBaselineReadSession
    readonly rootSets?: boolean
    readonly admissions?: readonly NativeUsageAdmission[]
  } = {},
): NativeUsageInvocationPersistence {
  const admissions = options.admissions?.map((item) => Object.freeze({ ...item }))
  return {
    forInvocation(input) {
      if (
        admissions !== undefined &&
        (!input.runtime ||
          !isRuntimeNativeUsageCaptureEligible(input.runtime.protocol) ||
          !admissions.some(
            (admission) =>
              admission.registrationId === input.runtime?.registrationId &&
              admission.configurationRevision === input.runtime?.configurationRevision,
          ))
      )
        return undefined
      const executionContext = currentTaskExecutionContext(input.taskId)
      if (!executionContext) return undefined
      const originalBinding = {
        taskId: input.taskId,
        nodeRunId: input.nodeRunId,
        invocationId: input.invocationId,
        executionContext,
      }
      const finalization = options.rootSets
        ? createNativeUsageFinalizationAuthority(originalBinding)
        : undefined
      const binding = finalization
        ? { ...originalBinding, finalization: finalization.reference }
        : originalBinding
      const pages = new DrizzleNativeUsagePages(db, true)
      const emissions = new DrizzleNativeUsageEmission(db)
      const completion = options.rootSets
        ? new DrizzleNativeUsageRootCompletion(db)
        : new DrizzleNativeUsageCompletion(db)
      let retryProof: ObservationAnyNativeCompletion | undefined
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
        ...(options.rootSets
          ? { rootCollection: createNativeUsageRootCollection(db, binding) }
          : {}),
        async prepare(request) {
          const before = await pages.prepare({ binding, ...request })
          finalization?.prepared(before)
          return before
        },
        passOwner,
        async withFinalOwner(before, read) {
          // Only the platform can supply an independent original read channel.
          // The original single-connection memory/PG path keeps its per-page verification.
          if ((!options.baselineSnapshots && !options.baselineRead) || before.mode !== 'resume')
            return read(passOwner(before))
          const original = await originalNativeUsageBaseline({ db, binding, before })
          if (!original) return read(passOwner(before, new DrizzleNativeUsagePages(db, true, null)))
          if (options.baselineRead)
            return options.baselineRead.run(
              {
                binding: {
                  taskId: binding.taskId,
                  nodeRunId: binding.nodeRunId,
                  invocationId: binding.invocationId,
                },
                original,
              },
              (baseline) =>
                read(passOwner(before, new DrizzleNativeUsagePages(db, true, baseline))),
            )
          return withNativeUsageBaselineSnapshot({
            snapshots: options.baselineSnapshots!,
            binding,
            original,
            run: (baseline) =>
              read(passOwner(before, new DrizzleNativeUsagePages(db, true, baseline))),
          })
        },
        recordProcess(nativeProcess) {
          finalization?.observe(nativeProcess)
          return emissions.emit({
            binding,
            eventId: 'native-process:' + sha256Hex(JSON.stringify(nativeProcess)),
            evidence: {
              invocationId: binding.invocationId,
              measurements: [],
              diagnostics: [],
              nativeProcess,
            },
          })
        },
        async seal(observedAt) {
          if (completeAck) return completeAck
          const proof = retryProof ?? (await completion.describeCompletion({ binding, observedAt }))
          retryProof = proof
          let ack: ObservationNativeSourceAck
          try {
            ack = await completion.seal({ binding, completion: proof })
          } catch (error) {
            if (error instanceof NativeRootCompletionCandidateChanged) retryProof = undefined
            throw error
          }
          retryProof = undefined
          if (proof.state === 'complete') completeAck = ack
          return ack
        },
      }
    },
  }
}
