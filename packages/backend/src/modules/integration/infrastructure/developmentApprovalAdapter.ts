import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DevelopmentAdapterContent } from '../domain/developmentAdapterDefinition'
import {
  runApprovalLookup,
  runApprovalObserve,
  runApprovalSubmit,
  type AdapterFailureReceipt,
} from './developmentAdapterRunner'

export interface ApprovalExecution {
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

export function createApprovalExecutionAdapter(deps: {
  readonly resolveBinding: (ref: string) => DevelopmentAdapterContent | null
  readonly extraEnv?: Record<string, string>
}): ApprovalExecution {
  const resolve = (
    ref: string,
    operation: 'submit' | 'lookup-by-idempotency-key' | 'observe',
  ): DevelopmentAdapterContent | null => {
    const content = deps.resolveBinding(ref)
    return content?.purpose === 'approval-gateway' && content.operations.includes(operation)
      ? content
      : null
  }
  const inSink = async <T>(fn: (sink: string) => Promise<T>): Promise<T> => {
    const sink = mkdtempSync(join(tmpdir(), 'aw-approval-adapter-'))
    try {
      return await fn(sink)
    } finally {
      rmSync(sink, { recursive: true, force: true })
    }
  }
  return {
    async submit(input) {
      const content = resolve(input.adapterBindingRef, 'submit')
      if (content === null) return fail('approval-adapter-submit-unavailable')
      return await inSink((stagedRoot) =>
        runApprovalSubmit({
          adapterContent: content,
          operation: {
            kind: 'approval.submit',
            stepRunRef: input.stepRunRef,
            draftRef: input.draftRef,
            deadlineAt: input.deadlineAt,
            idempotencyKey: input.idempotencyKey,
            intentDigest: input.intentDigest,
          },
          stagedRoot,
          extraEnv: deps.extraEnv,
        }),
      )
    },
    async lookup(input) {
      const content = resolve(input.adapterBindingRef, 'lookup-by-idempotency-key')
      if (content === null) return fail('approval-adapter-lookup-unavailable')
      return await inSink((stagedRoot) =>
        runApprovalLookup({
          adapterContent: content,
          operation: { kind: 'approval.lookup', idempotencyKey: input.idempotencyKey },
          stagedRoot,
          extraEnv: deps.extraEnv,
        }),
      )
    },
    async observe(input) {
      const content = resolve(input.adapterBindingRef, 'observe')
      if (content === null) return fail('approval-adapter-observe-unavailable')
      return await inSink((stagedRoot) =>
        runApprovalObserve({
          adapterContent: content,
          operation: { kind: 'approval.observe', correlationRef: input.correlationRef },
          stagedRoot,
          extraEnv: deps.extraEnv,
        }),
      )
    },
  }
}
