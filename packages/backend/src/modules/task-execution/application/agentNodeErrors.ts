import { ConflictError } from '@/util/errors'

/**
 * RFC-132 ③ / RFC-405 — the multi-ledger duplicate-execution reject of `resolveBorrowForNode`
 * surfaces as a node-level failure carrying the conflict's own code and message (it must not reject
 * the scope tick — runTask would fail the WHOLE task). Anything else is not this decision's to make.
 */
export function borrowDuplicateExecutionRejection(
  error: unknown,
): { readonly code: string; readonly summary: string } | null {
  return error instanceof ConflictError ? { code: error.code, summary: error.message } : null
}
