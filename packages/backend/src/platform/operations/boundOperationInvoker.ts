// RFC-344 — direct invocation of the handler chain bound to an operation id.
//
// HTTP and MCP share the exact handler instances registered on the one daemon
// root.  MCP never asks Hono to match a URL and never mounts or dispatches
// through a second app.  Existing route-owned operations retain their Hono
// decode/encode projection until their W4-B vertical slice; descriptor-backed
// routes already enter through registerOperationRoute's exact codecs.

import { Context, type Handler, type Hono, type MiddlewareHandler } from 'hono'
import type { BlankEnv } from 'hono/types'
import type { Actor } from '@/auth/actor'
import type {
  HttpMethod,
  HttpOperationInput,
  OperationId,
  OperationInvoker,
  OperationResult,
} from '@/platform/operations/contracts'
import { takeDeleteSnapshot } from '@/services/tokenAudit'
import { errorHandler } from '@/util/errors'

interface BoundOperationHandler {
  readonly method: HttpMethod
  readonly path: string
  readonly handlers: ReadonlyArray<Handler<BlankEnv, string>>
}

const BY_APP = new WeakMap<Hono, Map<OperationId, BoundOperationHandler>>()
const MIDDLEWARE_BY_APP = new WeakMap<
  Hono,
  Array<Readonly<{ path: string; handler: Handler<BlankEnv, string> }>>
>()

export class BoundOperationInvocationError extends Error {}

/**
 * Register route-table middleware that is part of operation behaviour. Global
 * transport middleware (authentication, logging, audit) is intentionally not
 * registered here; the MCP door has already authenticated and owns its audit.
 */
export function registerBoundOperationMiddleware<P extends string>(input: {
  readonly app: Hono
  readonly path: P
  readonly handler: MiddlewareHandler<BlankEnv, P>
}): void {
  let middleware = MIDDLEWARE_BY_APP.get(input.app)
  if (middleware === undefined) {
    middleware = []
    MIDDLEWARE_BY_APP.set(input.app, middleware)
  }
  middleware.push(
    Object.freeze({
      path: input.path,
      handler: input.handler as Handler<BlankEnv, string>,
    }),
  )
}

function sameBinding(left: BoundOperationHandler, right: BoundOperationHandler): boolean {
  return (
    left.method === right.method &&
    left.path === right.path &&
    left.handlers.length === right.handlers.length &&
    left.handlers.every((handler, index) => handler === right.handlers[index])
  )
}

/** Called only by registerRoute while assembling the one process root. */
export function registerBoundOperationHandler<P extends string>(input: {
  readonly app: Hono
  readonly operationId: OperationId
  readonly method: HttpMethod
  readonly path: P
  readonly gate: MiddlewareHandler
  readonly handlers: ReadonlyArray<Handler<BlankEnv, P>>
}): void {
  let handlers = BY_APP.get(input.app)
  if (handlers === undefined) {
    handlers = new Map()
    BY_APP.set(input.app, handlers)
  }
  const next: BoundOperationHandler = Object.freeze({
    method: input.method,
    path: input.path,
    handlers: Object.freeze([
      input.gate as Handler<BlankEnv, string>,
      ...(input.handlers as ReadonlyArray<Handler<BlankEnv, string>>),
    ]),
  })
  const existing = handlers.get(input.operationId)
  if (existing !== undefined && !sameBinding(existing, next)) {
    throw new BoundOperationInvocationError(
      `${input.operationId}: conflicting handler binding for ${input.method} ${input.path}`,
    )
  }
  handlers.set(input.operationId, next)
}

function materializeRequest(
  binding: BoundOperationHandler,
  input: HttpOperationInput,
): { request: Request; path: string; params: Readonly<Record<string, string>> } {
  const sourceParams = input.params ?? {}
  const consumed = new Set<string>()
  const params: Record<string, string> = {}
  const path = binding.path.replace(/:([A-Za-z0-9_]+)/g, (_match, rawName: string) => {
    const name = String(rawName)
    const value = sourceParams[name]
    if (value === undefined || value === '') {
      throw new BoundOperationInvocationError(`${binding.path}: missing path parameter '${name}'`)
    }
    consumed.add(name)
    params[name] = String(value)
    return encodeURIComponent(String(value))
  })
  const extra = Object.keys(sourceParams).filter((name) => !consumed.has(name))
  if (extra.length > 0) {
    throw new BoundOperationInvocationError(
      `${binding.path}: unknown path parameters: ${extra.join(', ')}`,
    )
  }
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) search.set(name, String(value))
  }
  const query = search.toString()
  const init: RequestInit = { method: binding.method }
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body)
    init.headers = { 'content-type': 'application/json' }
  }
  return {
    request: new Request(
      `http://operation.internal${path}${query === '' ? '' : `?${query}`}`,
      init,
    ),
    path,
    params,
  }
}

function middlewareMatches(pattern: string, concretePath: string): boolean {
  if (pattern === '*') return true
  const expected = pattern.split('/').filter(Boolean)
  const actual = concretePath.split('/').filter(Boolean)
  const wildcard = expected.at(-1) === '*'
  const prefixLength = wildcard ? expected.length - 1 : expected.length
  if (wildcard ? actual.length <= prefixLength : actual.length !== prefixLength) return false
  for (let index = 0; index < prefixLength; index += 1) {
    const part = expected[index]!
    if (!part.startsWith(':') && part !== actual[index]) return false
  }
  return true
}

async function runHandlerChain(
  context: Context,
  handlers: ReadonlyArray<Handler<BlankEnv, string>>,
): Promise<void> {
  let lastIndex = -1
  const dispatch = async (index: number): Promise<void> => {
    if (index <= lastIndex) throw new Error('next() called multiple times')
    lastIndex = index
    const handler = handlers[index]
    if (handler === undefined) return
    const response = await handler(context, () => dispatch(index + 1))
    if (response !== undefined && !context.finalized) context.res = response
  }
  try {
    await dispatch(0)
  } catch (error) {
    context.error = error instanceof Error ? error : new Error(String(error))
    context.res = await errorHandler(context.error, context)
  }
}

async function decodeResult(context: Context): Promise<OperationResult> {
  if (!context.finalized) {
    throw new BoundOperationInvocationError('operation handler completed without a response')
  }
  const response = context.res
  const auditSnapshot = takeDeleteSnapshot(context)
  if (response.status === 204) return { status: response.status, body: null, auditSnapshot }
  const text = await response.text()
  if (text === '') return { status: response.status, body: null, auditSnapshot }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, auditSnapshot }
  } catch {
    return { status: response.status, body: text, auditSnapshot }
  }
}

/**
 * Bind an already-authenticated actor to the app's closed handler table.
 * The caller supplies a stable operation id only; method/path never cross the
 * MCP boundary and Hono routing is not entered.
 */
export function createBoundOperationInvoker(app: Hono, actor: Actor): OperationInvoker {
  const operations = BY_APP.get(app)
  if (operations === undefined) {
    throw new BoundOperationInvocationError('operation handler table is not mounted')
  }
  return async (operationId, input = {}) => {
    const binding = operations.get(operationId)
    if (binding === undefined) {
      throw new BoundOperationInvocationError(`unknown or unmounted operation '${operationId}'`)
    }
    const materialized = materializeRequest(binding, input)
    const context = new Context(materialized.request, { env: {}, path: materialized.path })
    context.set('actor', actor)
    const request = context.req as typeof context.req & {
      param(name?: string): string | Readonly<Record<string, string>> | undefined
    }
    Object.defineProperty(request, 'param', {
      configurable: true,
      value: (name?: string) =>
        name === undefined ? materialized.params : materialized.params[name],
    })
    const operationMiddleware = (MIDDLEWARE_BY_APP.get(app) ?? [])
      .filter((entry) => middlewareMatches(entry.path, materialized.path))
      .map((entry) => entry.handler)
    await runHandlerChain(context, [...operationMiddleware, ...binding.handlers])
    return decodeResult(context)
  }
}
