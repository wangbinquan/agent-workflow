// RFC-344 — the single descriptor invocation pipeline shared by bindings.

import type { PublicErrorCode } from '@/platform/errors/publicError'
import type { VersionedExactCodec } from '@/platform/operations/contracts'
import { ValidationError } from '@/util/errors'

interface InvokableOperation<I, O, C> {
  readonly id: string
  readonly input: VersionedExactCodec<I>
  readonly output: VersionedExactCodec<O>
  readonly publicErrors: ReadonlyArray<PublicErrorCode>
  invoke(context: C, input: I): Promise<O> | O
}

export class OperationContractViolation extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OperationContractViolation'
  }
}

function declaredErrorCode(error: unknown): PublicErrorCode {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { readonly kind?: unknown; readonly status?: unknown }
    switch (candidate.kind) {
      case 'conflict':
        return 'conflict'
      case 'forbidden':
        return 'forbidden'
      case 'not-found':
        return 'not-found'
      case 'validation':
        return 'validation-failed'
    }
    switch (candidate.status) {
      case 403:
        return 'forbidden'
      case 404:
        return 'not-found'
      case 409:
      case 410:
        return 'conflict'
      case 412:
        return 'resource-operation-stale'
      case 422:
        return 'validation-failed'
      case 503:
        return 'unavailable'
    }
  }
  return 'internal-error'
}

export async function invokeOperation<I, O, C>(
  descriptor: InvokableOperation<I, O, C>,
  context: C,
  untrustedInput: unknown,
): Promise<O> {
  let input: I
  try {
    input = descriptor.input.parse(untrustedInput)
  } catch {
    throw new ValidationError('validation-failed', `invalid input for operation '${descriptor.id}'`)
  }
  let output: O
  try {
    output = await descriptor.invoke(context, input)
  } catch (error) {
    const code = declaredErrorCode(error)
    if (descriptor.publicErrors.includes(code)) throw error
    throw new OperationContractViolation(
      `${descriptor.id}: undeclared public error category '${code}'`,
      { cause: error },
    )
  }
  try {
    return descriptor.output.parse(output)
  } catch (error) {
    throw new OperationContractViolation(`${descriptor.id}: invalid operation output`, {
      cause: error,
    })
  }
}
