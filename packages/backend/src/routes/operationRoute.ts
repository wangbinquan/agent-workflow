// RFC-344 — HTTP projection for a transport-neutral operation descriptor.

import type { Context, Handler, Hono, MiddlewareHandler } from 'hono'
import type { BlankEnv } from 'hono/types'
import { declareHttpOperation, registerOperationDescriptor } from '@/platform/operations/catalog'
import type {
  CommandOperationDescriptor,
  HttpMethod,
  IdempotentCommandOperationDescriptor,
  QueryOperationDescriptor,
  TokenAccess,
} from '@/platform/operations/contracts'
import { invokeOperation } from '@/platform/operations/invoke'
import { registerRoute } from '@/routes/registry'

type HttpDescriptor<I, O, C> =
  | CommandOperationDescriptor<I, O, C>
  | IdempotentCommandOperationDescriptor<I, O, C>
  | QueryOperationDescriptor<I, O, C>

export interface OperationHttpBinding<P extends string, I, O, C> {
  readonly descriptor: HttpDescriptor<I, O, C>
  readonly method: HttpMethod
  readonly path: P
  readonly tokenAccess: TokenAccess
  /** Pure HTTP fields -> operation input projection; codec runs immediately after. */
  readonly decode: (context: Context<BlankEnv, P>) => Promise<unknown> | unknown
  /** Route-owned transport middleware that must remain in the declared handler chain. */
  readonly middleware?: MiddlewareHandler<BlankEnv, P>
  /** Trusted direct authority factory for the descriptor's exact context kind. */
  readonly context: (context: Context<BlankEnv, P>) => Promise<C> | C
  /** Operation output -> established HTTP status/body projection. */
  readonly encode: (context: Context<BlankEnv, P>, output: O) => Promise<Response> | Response
  /** Application error -> established transport error mapping. */
  readonly mapError?: (
    error: unknown,
    context: Context<BlankEnv, P>,
  ) => Promise<Response> | Response
}

/**
 * Register one HTTP binding without restating admission or summary metadata.
 * The exact input and output codecs surround the single descriptor invoke.
 */
export function registerOperationRoute<P extends string, I, O, C>(
  app: Hono,
  binding: OperationHttpBinding<P, I, O, C>,
): void {
  const descriptor = binding.descriptor
  registerOperationDescriptor(descriptor)
  declareHttpOperation({
    id: descriptor.id,
    kind: descriptor.kind,
    method: binding.method,
    path: binding.path,
    implementation: 'descriptor',
  })
  const meta = {
    method: binding.method,
    path: binding.path,
    permissions: descriptor.permissions,
    ...(descriptor.publicReason === undefined ? {} : { publicReason: descriptor.publicReason }),
    tokenAccess: binding.tokenAccess,
    summary: descriptor.summary,
  } as const
  const handler: Handler<BlankEnv, P> = async (httpContext) => {
    try {
      const operationContext = await binding.context(httpContext)
      const output = await invokeOperation(
        descriptor,
        operationContext,
        await binding.decode(httpContext),
      )
      return binding.encode(httpContext, output)
    } catch (error) {
      if (binding.mapError !== undefined) return binding.mapError(error, httpContext)
      throw error
    }
  }
  if (binding.middleware === undefined) registerRoute(app, meta, handler)
  else registerRoute(app, meta, binding.middleware, handler)
}
