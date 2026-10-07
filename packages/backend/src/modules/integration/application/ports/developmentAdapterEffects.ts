import type {
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '@/modules/development-automation/public/types'

export type AdapterFailureCategory =
  | 'transient'
  | 'stale-input'
  | 'configuration'
  | 'permission'
  | 'invalid-user-input'
  | 'business-failure'
  | 'contract-violation'
export type AdapterRetryability = 'same-input' | 'after-refresh' | 'after-configuration' | 'never'
export interface AdapterFailureReceipt {
  readonly category: AdapterFailureCategory
  readonly code: string
  readonly retryability: AdapterRetryability
  readonly attemptOrdinal: number
  readonly remediation: string
  readonly evidenceRef: string | null
}

export interface AdapterConfigurationReference {
  readonly kind: 'development-adapter-configuration'
  readonly reference: object
}

export interface AdapterProgramReference {
  readonly kind: 'development-adapter-program'
  readonly reference: object
}

/** Preparation can return the original closed failure before any execution. */
export type AdapterProgramBindingResult =
  | { readonly ok: true; readonly program: AdapterProgramReference }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }

export interface AdapterProgramFactory {
  bind(
    configuration: AdapterConfigurationReference,
  ): AdapterProgramBindingResult | Promise<AdapterProgramBindingResult>
}

/** Returning an observation acknowledges execution, output and original cleanup. */
export type AdapterProcessObservation =
  | { readonly kind: 'completed'; readonly stdout: string; readonly exitCode: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable' }

interface AdapterProgramOperationInput {
  readonly program: AdapterProgramReference
  readonly staging: EvidenceStagingReference
}

export interface RequirementAdapterEffects {
  readonly namespace: EvidenceStagingNamespace
  readonly programs: AdapterProgramFactory
  acquire(
    input: AdapterProgramOperationInput & { readonly externalId: string },
  ): Promise<AdapterProcessObservation>
  questionsWriteback(
    input: AdapterProgramOperationInput & {
      readonly externalId: string
      readonly questionsJson: string
    },
  ): Promise<AdapterProcessObservation>
  answersCollect(
    input: AdapterProgramOperationInput & {
      readonly externalId: string
      readonly correlationRef: string
    },
  ): Promise<AdapterProcessObservation>
}

export interface PipelineAdapterEffects {
  readonly namespace: EvidenceStagingNamespace
  readonly programs: AdapterProgramFactory
  collect(
    input: AdapterProgramOperationInput & {
      readonly headSha: string
      readonly targetSha: string
      readonly gateKeysCsv: string
    },
  ): Promise<AdapterProcessObservation>
  trigger(
    input: AdapterProgramOperationInput & {
      readonly headSha: string
      readonly gateKeysCsv: string
      readonly idempotencyKey: string
    },
  ): Promise<AdapterProcessObservation>
  rerun(
    input: AdapterProgramOperationInput & {
      readonly runRef: string
      readonly gateKey: string
      readonly headSha: string
      readonly idempotencyKey: string
    },
  ): Promise<AdapterProcessObservation>
}

export interface ApprovalAdapterEffects {
  readonly namespace: EvidenceStagingNamespace
  readonly programs: AdapterProgramFactory
  submit(
    input: AdapterProgramOperationInput & {
      readonly stepRunRef: string
      readonly draftRef: string
      readonly deadlineAt: string
      readonly idempotencyKey: string
      readonly intentDigest: string
    },
  ): Promise<AdapterProcessObservation>
  lookup(
    input: AdapterProgramOperationInput & { readonly idempotencyKey: string },
  ): Promise<AdapterProcessObservation>
  observe(
    input: AdapterProgramOperationInput & { readonly correlationRef: string },
  ): Promise<AdapterProcessObservation>
}
