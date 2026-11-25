// RFC-502 (RFC-294 S10 step 9): the approval gateway's receipt projection (adapter binding ref, intent digest and the
// submit / lookup / observe receipts), moved here unchanged from composition/approvalGateway.ts, where the same 66 lines
// appeared twice (the legacy env-secret runner and the selected-binding runner); both runners now pass their execution here.

import { sha256Hex } from '@/platform/contracts/hash'
import type { SelectedApprovalExecution } from './developmentApprovalAdapter'

export function createDevelopmentApprovalGateway(execution: SelectedApprovalExecution) {
  const binding = (ref: { id: string; revision: number }): string => `${ref.id}@${ref.revision}`
  const canonical = (value: unknown): string => {
    const encode = (item: unknown): string => {
      if (
        item === null ||
        typeof item === 'boolean' ||
        typeof item === 'number' ||
        typeof item === 'string'
      ) {
        return JSON.stringify(item)
      }
      if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`
      const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      )
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`).join(',')}}`
    }
    return encode(value)
  }
  return {
    async submit(input: {
      stepRunRef: string
      adapterRef: { id: string; revision: number }
      validatedDraftRef: string
      deadlineAt: string
      idempotencyKey: string
    }) {
      const result = await execution.submit({
        adapterBindingRef: binding(input.adapterRef),
        stepRunRef: input.stepRunRef,
        draftRef: input.validatedDraftRef,
        deadlineAt: input.deadlineAt,
        idempotencyKey: input.idempotencyKey,
        intentDigest: sha256Hex(canonical(input)),
      })
      if (!result.ok) return result
      const { operation: _operation, protocol: _protocol, ...receipt } = result.envelope
      return { ok: true as const, receipt }
    },
    async lookupByIdempotencyKey(input: {
      adapterRef: { id: string; revision: number }
      idempotencyKey: string
    }) {
      const result = await execution.lookup({
        adapterBindingRef: binding(input.adapterRef),
        idempotencyKey: input.idempotencyKey,
      })
      if (!result.ok || !result.envelope.found) return null
      const {
        found: _found,
        operation: _operation,
        protocol: _protocol,
        ...receipt
      } = result.envelope
      return receipt
    },
    async observe(input: { adapterRef: { id: string; revision: number }; correlationRef: string }) {
      const result = await execution.observe({
        adapterBindingRef: binding(input.adapterRef),
        correlationRef: input.correlationRef,
      })
      if (!result.ok) return result
      const { operation: _operation, protocol: _protocol, ...receipt } = result.envelope
      return { ok: true as const, receipt }
    },
  }
}
