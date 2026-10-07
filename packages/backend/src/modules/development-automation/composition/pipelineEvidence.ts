import type { SelectedPipelineEvidenceExecution } from '@/modules/integration/public/participants'
import type { PipelineEvidencePort } from '../application/ports/reconcilerPorts'
import type { PipelineStagingFactories } from '../application/ports/evidenceStaging'
import { assertEvidenceStagingFactory, assertEvidenceStagingLease } from '../public/evidenceStaging'
export {
  composeLegacyDevelopmentPipelineEvidence,
  type LegacyPipelineEvidencePort,
} from '../infrastructure/local/legacyPipelineEvidence'

export function composeSelectedDevelopmentPipelineEvidence(
  runner: SelectedPipelineEvidenceExecution,
  staging: PipelineStagingFactories,
): {
  readonly pipelineEvidence: PipelineEvidencePort
} {
  type RunnerFailure = Extract<
    Awaited<ReturnType<typeof runner.collect>>,
    { readonly ok: false }
  >['failure']
  const failed = (failure: RunnerFailure) => ({ ok: false as const, failure })
  for (const factory of [staging.collect, staging.trigger, staging.rerun])
    assertEvidenceStagingFactory(factory)
  return {
    pipelineEvidence: {
      async collect(input) {
        const allocation = staging.collect.create()
        const parent = 'then' in allocation ? await allocation : allocation
        assertEvidenceStagingLease(parent, staging.collect.namespace)
        const out = await runner.collect({ ...input, staging: parent.reference })
        if (!out.ok) {
          const closed = parent.close()
          if (closed !== undefined) await closed
          return failed(out.failure)
        }
        return {
          ok: true,
          envelope: out.envelope,
          staging: parent,
          outputBudget: out.outputBudget,
          cleanup: () => parent.close(),
        }
      },
      async trigger(input) {
        const allocation = staging.trigger.create()
        const parent = 'then' in allocation ? await allocation : allocation
        assertEvidenceStagingLease(parent, staging.trigger.namespace)
        try {
          const out = await runner.trigger({ ...input, staging: parent.reference })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            providerReceiptRef: out.envelope.providerReceiptRef,
            adopted: out.envelope.adopted,
          }
        } finally {
          const closed = parent.close()
          if (closed !== undefined) await closed
        }
      },
      async rerun(input) {
        const allocation = staging.rerun.create()
        const parent = 'then' in allocation ? await allocation : allocation
        assertEvidenceStagingLease(parent, staging.rerun.namespace)
        try {
          const out = await runner.rerun({ ...input, staging: parent.reference })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            attempt: out.envelope.attempt,
            providerReceiptRef: out.envelope.providerReceiptRef,
          }
        } finally {
          const closed = parent.close()
          if (closed !== undefined) await closed
        }
      },
    },
  }
}
