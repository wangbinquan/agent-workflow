import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { createApprovalExecutionAdapter } from '../infrastructure/developmentApprovalAdapter'
import { createAsyncDbAdapterBindingResolver } from '../infrastructure/developmentRequirementSourceAdapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

function gateway(input: {
  readonly resolveBinding: Parameters<typeof createApprovalExecutionAdapter>[0]['resolveBinding']
  readonly approvalMockUrl?: string
}) {
  const secretSource = Object.freeze({ ...process.env })
  const mockUrl = input.approvalMockUrl ?? process.env.AW_APPROVAL_MOCK_URL
  const execution = createApprovalExecutionAdapter({
    resolveBinding: input.resolveBinding,
    secretSource,
    ...(mockUrl === undefined ? {} : { extraEnv: { AW_APPROVAL_MOCK_URL: mockUrl } }),
  })
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

/** RFC-359 W4-D6：一份装配，两个 provider 共用（绑定解析经中立 store 的 Promise 读）。 */
export function composeApprovalGatewayRunnerFor(
  db: ProviderNeutralDatabase,
  options: { readonly approvalMockUrl?: string } = {},
) {
  const store = createDevelopmentAdapterStore(db)
  return gateway({
    resolveBinding: createAsyncDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
    ...options,
  })
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export const composeSqliteApprovalGatewayRunner = composeApprovalGatewayRunnerFor
export const composePostgresqlApprovalGatewayRunner = composeApprovalGatewayRunnerFor
