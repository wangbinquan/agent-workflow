import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PipelineEvidenceExecution } from '@/modules/integration/public/participants'
import type { PipelineCollectEnvelopeDto } from '../../application/ports/reconcilerPorts'
import type { OperationFailureReceipt } from '../../domain/operationFailure'

export interface LegacyPipelineEvidencePort {
  collect(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly targetSha: string
    readonly gateKeys: readonly string[]
  }): Promise<
    | {
        readonly ok: true
        readonly envelope: PipelineCollectEnvelopeDto
        readonly stagedRoot: string
        readonly outputBudget: {
          readonly maxFiles: number
          readonly maxFileBytes: number
          readonly maxTotalBytes: number
        }
        cleanup(): void
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  trigger(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly gateKeys: readonly string[]
    readonly idempotencyKey: string
  }): Promise<
    | {
        readonly ok: true
        readonly runRef: string
        readonly providerReceiptRef: string
        readonly adopted: boolean
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  rerun(input: {
    readonly adapterBindingRef: string
    readonly runRef: string
    readonly gateKey: string
    readonly headSha: string
    readonly idempotencyKey: string
  }): Promise<
    | {
        readonly ok: true
        readonly runRef: string
        readonly attempt: number
        readonly providerReceiptRef: string
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
}

export function composeLegacyDevelopmentPipelineEvidence(runner: PipelineEvidenceExecution): {
  readonly pipelineEvidence: LegacyPipelineEvidencePort
} {
  type RunnerFailure = Extract<
    Awaited<ReturnType<typeof runner.collect>>,
    { readonly ok: false }
  >['failure']
  const failed = (failure: RunnerFailure) => ({ ok: false as const, failure })
  return {
    pipelineEvidence: {
      async collect(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-sink-'))
        const out = await runner.collect({ ...input, sinkPath: parent })
        if (!out.ok) {
          rmSync(parent, { recursive: true, force: true })
          return failed(out.failure)
        }
        return {
          ok: true,
          envelope: out.envelope,
          stagedRoot: parent,
          outputBudget: out.outputBudget,
          cleanup: () => rmSync(parent, { recursive: true, force: true }),
        }
      },
      async trigger(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-trigger-'))
        try {
          const out = await runner.trigger({ ...input, sinkPath: parent })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            providerReceiptRef: out.envelope.providerReceiptRef,
            adopted: out.envelope.adopted,
          }
        } finally {
          rmSync(parent, { recursive: true, force: true })
        }
      },
      async rerun(input) {
        const parent = mkdtempSync(join(tmpdir(), 'aw-pipeline-rerun-'))
        try {
          const out = await runner.rerun({ ...input, sinkPath: parent })
          if (!out.ok) return failed(out.failure)
          return {
            ok: true,
            runRef: out.envelope.runRef,
            attempt: out.envelope.attempt,
            providerReceiptRef: out.envelope.providerReceiptRef,
          }
        } finally {
          rmSync(parent, { recursive: true, force: true })
        }
      },
    },
  }
}
