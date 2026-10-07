// Legacy physical input facade. New consumers select complete logical purpose bindings.
import * as selected from '../application/developmentAdapterRunner'
import type { AdapterRunInput as SelectedAdapterRunInput } from '../application/developmentAdapterRunner'
import {
  createLocalDevelopmentAdapterEffects,
  type NativeAdapterRunInput,
} from './local/developmentAdapterProgram'
export type {
  AdapterFailureCategory,
  AdapterFailureReceipt,
  AdapterRetryability,
  AdapterRunResult,
} from '../application/developmentAdapterRunner'
export type AdapterRunInput = NativeAdapterRunInput
export {
  acquireEnvelopeSchema,
  writebackEnvelopeSchema,
  collectAnswersEnvelopeSchema,
  pipelineCollectEnvelopeSchema,
  pipelineTriggerEnvelopeSchema,
  pipelineRerunEnvelopeSchema,
  approvalSubmitEnvelopeSchema,
  approvalLookupEnvelopeSchema,
  approvalObserveEnvelopeSchema,
} from '../application/developmentAdapterRunner'

function prepare(
  input: AdapterRunInput,
  purpose: 'requirement' | 'pipeline' | 'approval',
): SelectedAdapterRunInput {
  const namespace = { kind: 'evidence-staging-namespace' as const, reference: {} }
  const reference = { kind: 'evidence-staging' as const, namespace, reference: {} }
  const native = createLocalDevelopmentAdapterEffects({
    namespace,
    resolveStaging(staging) {
      if (staging !== reference) throw new Error('legacy-adapter-staging-unknown')
      return input.stagedRoot
    },
  })
  return {
    configuration: native.configurationFor(input),
    staging: reference,
    effects: native[purpose],
    operation: input.operation,
  }
}

export async function runRequirementAcquire(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runRequirementAcquire>[0]['operation']
  },
): ReturnType<typeof selected.runRequirementAcquire> {
  return selected.runRequirementAcquire({
    ...prepare(input, 'requirement'),
    operation: input.operation,
  })
}

export async function runQuestionsWriteback(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runQuestionsWriteback>[0]['operation']
  },
): ReturnType<typeof selected.runQuestionsWriteback> {
  return selected.runQuestionsWriteback({
    ...prepare(input, 'requirement'),
    operation: input.operation,
  })
}

export async function runAnswersCollect(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runAnswersCollect>[0]['operation']
  },
): ReturnType<typeof selected.runAnswersCollect> {
  return selected.runAnswersCollect({
    ...prepare(input, 'requirement'),
    operation: input.operation,
  })
}

export async function runPipelineCollect(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runPipelineCollect>[0]['operation']
  },
): ReturnType<typeof selected.runPipelineCollect> {
  return selected.runPipelineCollect({ ...prepare(input, 'pipeline'), operation: input.operation })
}

export async function runPipelineTrigger(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runPipelineTrigger>[0]['operation']
  },
): ReturnType<typeof selected.runPipelineTrigger> {
  return selected.runPipelineTrigger({ ...prepare(input, 'pipeline'), operation: input.operation })
}

export async function runPipelineRerun(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runPipelineRerun>[0]['operation']
  },
): ReturnType<typeof selected.runPipelineRerun> {
  return selected.runPipelineRerun({ ...prepare(input, 'pipeline'), operation: input.operation })
}

export async function runApprovalSubmit(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runApprovalSubmit>[0]['operation']
  },
): ReturnType<typeof selected.runApprovalSubmit> {
  return selected.runApprovalSubmit({ ...prepare(input, 'approval'), operation: input.operation })
}

export async function runApprovalLookup(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runApprovalLookup>[0]['operation']
  },
): ReturnType<typeof selected.runApprovalLookup> {
  return selected.runApprovalLookup({ ...prepare(input, 'approval'), operation: input.operation })
}

export async function runApprovalObserve(
  input: AdapterRunInput & {
    readonly operation: Parameters<typeof selected.runApprovalObserve>[0]['operation']
  },
): ReturnType<typeof selected.runApprovalObserve> {
  return selected.runApprovalObserve({ ...prepare(input, 'approval'), operation: input.operation })
}
