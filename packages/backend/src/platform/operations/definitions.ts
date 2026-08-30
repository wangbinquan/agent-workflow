// RFC-344 — typed constructors for owning-module operation descriptors.

import type { Permission } from '@agent-workflow/shared'
import type { output, ZodTypeAny } from 'zod'
import type { PublicErrorCode } from '@/platform/errors/publicError'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'

interface Definition<TInput extends ZodTypeAny, TOutput extends ZodTypeAny> {
  readonly id: string
  readonly summary: string
  readonly permissions: ReadonlyArray<Permission>
  readonly publicReason?: string
  readonly publicErrors: ReadonlyArray<PublicErrorCode>
  readonly inputSchema: TInput
  readonly outputSchema: TOutput
}

function codecs<TInput extends ZodTypeAny, TOutput extends ZodTypeAny>(
  definition: Definition<TInput, TOutput>,
) {
  return {
    id: operationId(definition.id),
    summary: definition.summary,
    permissions: definition.permissions,
    ...(definition.publicReason === undefined ? {} : { publicReason: definition.publicReason }),
    publicErrors: definition.publicErrors,
    input: zodOperationCodec(`${definition.id}.input`, definition.inputSchema),
    output: zodOperationCodec(`${definition.id}.output`, definition.outputSchema),
  }
}

export function defineQueryOperation<
  TInput extends ZodTypeAny,
  TOutput extends ZodTypeAny,
  TContext,
>(
  definition: Definition<TInput, TOutput> & {
    readonly invoke: (
      context: TContext,
      input: output<TInput>,
    ) => Promise<output<TOutput>> | output<TOutput>
  },
): QueryOperationDescriptor<output<TInput>, output<TOutput>, TContext> {
  return Object.freeze({
    ...codecs(definition),
    kind: 'query',
    contextKind: 'authenticated-query',
    invoke: definition.invoke,
  })
}

export function defineCommandOperation<
  TInput extends ZodTypeAny,
  TOutput extends ZodTypeAny,
  TContext,
>(
  definition: Definition<TInput, TOutput> & {
    readonly invoke: (
      context: TContext,
      input: output<TInput>,
    ) => Promise<output<TOutput>> | output<TOutput>
  },
): CommandOperationDescriptor<output<TInput>, output<TOutput>, TContext> {
  return Object.freeze({
    ...codecs(definition),
    kind: 'command',
    contextKind: 'authenticated-command',
    invoke: definition.invoke,
  })
}
