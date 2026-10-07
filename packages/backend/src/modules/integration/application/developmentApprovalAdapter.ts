import { assertDevelopmentAdapterBinding } from './developmentAdapterBinding'
import type { EvidenceStagingReference } from '@/modules/development-automation/public/types'
import type { ApprovalAdapterBinding } from './ports/developmentPurposeBinding'
import { assertEvidenceStagingLease } from '@/modules/development-automation/public/participants'
import type { DevelopmentAdapterContent } from '../domain/developmentAdapterDefinition'
import {
  runApprovalLookup,
  runApprovalObserve,
  runApprovalSubmit,
  type AdapterFailureReceipt,
} from './developmentAdapterRunner'

export interface SelectedApprovalExecution {
  submit(input: {
    readonly adapterBindingRef: string
    readonly stepRunRef: string
    readonly draftRef: string
    readonly deadlineAt: string
    readonly idempotencyKey: string
    readonly intentDigest: string
  }): Promise<ReturnType<typeof runApprovalSubmit> extends Promise<infer T> ? T : never>
  lookup(input: {
    readonly adapterBindingRef: string
    readonly idempotencyKey: string
  }): Promise<ReturnType<typeof runApprovalLookup> extends Promise<infer T> ? T : never>
  observe(input: {
    readonly adapterBindingRef: string
    readonly correlationRef: string
  }): Promise<ReturnType<typeof runApprovalObserve> extends Promise<infer T> ? T : never>
}

function fail(code: string): { readonly ok: false; readonly failure: AdapterFailureReceipt } {
  return {
    ok: false,
    failure: {
      category: 'configuration',
      code,
      retryability: 'after-configuration',
      attemptOrdinal: 0,
      remediation: code,
      evidenceRef: null,
    },
  }
}

export function createSelectedApprovalExecutionAdapter(deps: {
  readonly resolveBinding: (
    ref: string,
  ) => DevelopmentAdapterContent | null | Promise<DevelopmentAdapterContent | null>
  readonly binding: ApprovalAdapterBinding
}): SelectedApprovalExecution {
  assertDevelopmentAdapterBinding(
    deps.binding,
    ['submit', 'lookup', 'observe'],
    [deps.binding.staging],
  )
  const resolve = async (
    ref: string,
    operation: 'submit' | 'lookup-by-idempotency-key' | 'observe',
  ): Promise<DevelopmentAdapterContent | null> => {
    const content = await deps.resolveBinding(ref)
    return content?.purpose === 'approval-gateway' && content.operations.includes(operation)
      ? content
      : null
  }
  const inSink = async <T>(fn: (staging: EvidenceStagingReference) => Promise<T>): Promise<T> => {
    const allocation = deps.binding.staging.create()
    const lease = 'then' in allocation ? await allocation : allocation
    assertEvidenceStagingLease(lease, deps.binding.staging.namespace)
    try {
      return await fn(lease.reference)
    } finally {
      const closed = lease.close()
      if (closed !== undefined) await closed
    }
  }

  return {
    async submit(input) {
      const content = await resolve(input.adapterBindingRef, 'submit')
      if (content === null) return fail('approval-adapter-submit-unavailable')
      return await inSink((staging) =>
        runApprovalSubmit({
          configuration: deps.binding.configurationFor(content),
          effects: deps.binding.effects,
          operation: {
            kind: 'approval.submit',
            stepRunRef: input.stepRunRef,
            draftRef: input.draftRef,
            deadlineAt: input.deadlineAt,
            idempotencyKey: input.idempotencyKey,
            intentDigest: input.intentDigest,
          },
          staging,
        }),
      )
    },
    async lookup(input) {
      const content = await resolve(input.adapterBindingRef, 'lookup-by-idempotency-key')
      if (content === null) return fail('approval-adapter-lookup-unavailable')
      return await inSink((staging) =>
        runApprovalLookup({
          configuration: deps.binding.configurationFor(content),
          effects: deps.binding.effects,
          operation: { kind: 'approval.lookup', idempotencyKey: input.idempotencyKey },
          staging,
        }),
      )
    },
    async observe(input) {
      const content = await resolve(input.adapterBindingRef, 'observe')
      if (content === null) return fail('approval-adapter-observe-unavailable')
      return await inSink((staging) =>
        runApprovalObserve({
          configuration: deps.binding.configurationFor(content),
          effects: deps.binding.effects,
          operation: { kind: 'approval.observe', correlationRef: input.correlationRef },
          staging,
        }),
      )
    },
  }
}
