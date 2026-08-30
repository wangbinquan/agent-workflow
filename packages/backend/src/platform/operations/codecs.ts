// RFC-344 — adapters for exact, versioned application-boundary codecs.

import type { output, ZodTypeAny } from 'zod'
import type { VersionedExactCodec } from '@/platform/operations/contracts'

/**
 * The supplied schema owns strictness. Operation schemas must use strict
 * objects (including nested objects where appropriate); this adapter does not
 * hide Zod failures or coerce an output after the use case returned it.
 */
export function zodOperationCodec<TSchema extends ZodTypeAny>(
  name: string,
  schema: TSchema,
  version = 1,
): VersionedExactCodec<output<TSchema>> {
  if (name.trim() === '') throw new Error('operation codec name is required')
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('operation codec version must be a positive integer')
  }
  return Object.freeze({
    name,
    version,
    parse(value: unknown): output<TSchema> {
      return schema.parse(value)
    },
  })
}
