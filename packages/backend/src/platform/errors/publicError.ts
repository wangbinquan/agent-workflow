// RFC-294 W0-R — the only public-error serialization contract for future
// inbound adapter cutovers.  Existing transports are deliberately not switched
// in N1: this file establishes the fail-closed allowlist without changing wire
// behaviour before the owning W4/W9 slices migrate each endpoint.

export type AppErrorCategory =
  | 'conflict'
  | 'forbidden'
  | 'internal'
  | 'not-found'
  | 'stale'
  | 'unavailable'
  | 'validation'

export interface PublicErrorDetailMap {
  readonly 'resource-operation-stale': {
    readonly expectedRevision: number
    readonly actualRevision: number
  }
  readonly 'validation-failed': {
    readonly fields: readonly {
      readonly field: string
      readonly code: string
    }[]
  }
}

export const PUBLIC_ERROR_DEFINITIONS = {
  'not-found': { category: 'not-found', message: 'The requested resource was not found.' },
  forbidden: { category: 'forbidden', message: 'Access is forbidden.' },
  'validation-failed': { category: 'validation', message: 'The request is invalid.' },
  'resource-operation-stale': {
    category: 'stale',
    message: 'The resource changed; refresh and try again.',
  },
  conflict: { category: 'conflict', message: 'The operation conflicts with current state.' },
  unavailable: { category: 'unavailable', message: 'The operation is temporarily unavailable.' },
  'internal-error': { category: 'internal', message: 'An internal error occurred.' },
} as const satisfies Readonly<
  Record<string, { readonly category: AppErrorCategory; readonly message: string }>
>

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_DEFINITIONS

export type PublicErrorDTO<TCode extends PublicErrorCode = PublicErrorCode> = Readonly<{
  code: TCode
  category: (typeof PUBLIC_ERROR_DEFINITIONS)[TCode]['category']
  message: string
  details?: TCode extends keyof PublicErrorDetailMap ? PublicErrorDetailMap[TCode] : never
  correlationId: string
}>

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  )
}

function staleDetails(value: unknown): PublicErrorDetailMap['resource-operation-stale'] | null {
  const input = record(value)
  if (input === null || !hasExactKeys(input, ['actualRevision', 'expectedRevision'])) return null
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    !Number.isSafeInteger(input.actualRevision)
  ) {
    return null
  }
  return Object.freeze({
    expectedRevision: input.expectedRevision as number,
    actualRevision: input.actualRevision as number,
  })
}

function validationDetails(value: unknown): PublicErrorDetailMap['validation-failed'] | null {
  const input = record(value)
  if (input === null || !hasExactKeys(input, ['fields']) || !Array.isArray(input.fields))
    return null
  const fields: Array<{ readonly field: string; readonly code: string }> = []
  for (const candidate of input.fields) {
    const item = record(candidate)
    if (
      item === null ||
      !hasExactKeys(item, ['code', 'field']) ||
      typeof item.field !== 'string' ||
      item.field === '' ||
      typeof item.code !== 'string' ||
      item.code === ''
    ) {
      return null
    }
    fields.push(Object.freeze({ field: item.field, code: item.code }))
  }
  return Object.freeze({ fields: Object.freeze(fields) })
}

function isPublicCode(value: unknown): value is PublicErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_DEFINITIONS, value)
  )
}

/**
 * Build a JSON-safe public DTO from an unknown private error.
 *
 * The mapper never copies `Error.message`, `cause`, stack, enumerable debug
 * fields, or an unknown `details` shape.  Unknown codes and malformed detail
 * payloads fail closed to an allowlisted message/shape.
 */
export function toPublicError(error: unknown, correlationId: string): PublicErrorDTO {
  const input = record(error)
  const code: PublicErrorCode = isPublicCode(input?.code) ? input.code : 'internal-error'
  const definition = PUBLIC_ERROR_DEFINITIONS[code]
  const base = {
    code,
    category: definition.category,
    message: definition.message,
    correlationId: correlationId.trim() || 'missing-correlation-id',
  }
  if (code === 'resource-operation-stale') {
    const details = staleDetails(input?.details)
    return Object.freeze(details === null ? base : { ...base, details }) as PublicErrorDTO
  }
  if (code === 'validation-failed') {
    const details = validationDetails(input?.details)
    return Object.freeze(details === null ? base : { ...base, details }) as PublicErrorDTO
  }
  return Object.freeze(base) as PublicErrorDTO
}
