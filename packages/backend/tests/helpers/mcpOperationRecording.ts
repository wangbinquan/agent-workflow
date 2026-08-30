import {
  lookupDeclaredHttpOperationById,
  OperationCatalogError,
} from '@/platform/operations/catalog'
import type {
  HttpOperationInput,
  HttpMethod,
  OperationId,
  OperationInvoker,
  OperationResult,
} from '@/platform/operations/contracts'
import { bindingForTool } from '@/mcp/operationBindings'
import { createBoundMcpOperationHandles, type McpOperationHandles } from '@/mcp/operationClient'
import type { Actor } from '@/auth/actor'

export interface RecordedOperationCall {
  readonly operationId: OperationId
  readonly method: HttpMethod
  readonly path: string
  readonly body?: unknown
  readonly query?: Record<string, string | undefined>
}

/** Test-only stand-in for the already-selected MCP transport door. */
export function mcpTestOperationActor(actor: Actor): Actor {
  return { ...actor, purpose: undefined }
}

function pathFor(template: string, input: HttpOperationInput): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = input.params?.[name]
    if (value === undefined) throw new Error(`${template}: missing ${name}`)
    return encodeURIComponent(String(value))
  })
}

export function recordingOperationInvoker(
  calls: RecordedOperationCall[],
  respond: (call: RecordedOperationCall) => unknown = () => ({}),
): OperationInvoker {
  return async (operationId, input = {}): Promise<OperationResult> => {
    const operation = lookupDeclaredHttpOperationById(operationId)
    if (operation === undefined)
      throw new OperationCatalogError(`unknown operation '${operationId}'`)
    const query =
      input.query === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.query).map(([name, value]) => [
              name,
              value === undefined ? undefined : String(value),
            ]),
          )
    const call: RecordedOperationCall = {
      operationId,
      method: operation.method,
      path: pathFor(operation.path, input),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(query === undefined ? {} : { query }),
    }
    calls.push(call)
    return { status: 200, body: respond(call) }
  }
}

export function forwardingOperationInvoker(
  calls: RecordedOperationCall[],
  forward: (call: RecordedOperationCall) => Promise<OperationResult> | OperationResult,
): OperationInvoker {
  return async (operationId, input = {}) => {
    let recorded: RecordedOperationCall | undefined
    await recordingOperationInvoker([], (call) => {
      recorded = call
      return null
    })(operationId, input)
    if (recorded === undefined) throw new Error(`operation '${operationId}' was not recorded`)
    calls.push(recorded)
    return forward(recorded)
  }
}

export function recordingOperationHandles(
  toolName: string,
  calls: RecordedOperationCall[],
  respond: (call: RecordedOperationCall) => unknown = () => ({}),
): McpOperationHandles {
  const binding = bindingForTool(toolName)
  if (binding === undefined) throw new Error(`${toolName}: missing operation binding`)
  return createBoundMcpOperationHandles({
    binding,
    invoke: recordingOperationInvoker(calls, respond),
    observe: () => undefined,
  })
}

export function forwardingOperationHandles(
  toolName: string,
  calls: RecordedOperationCall[],
  forward: (call: RecordedOperationCall) => Promise<OperationResult> | OperationResult,
): McpOperationHandles {
  const binding = bindingForTool(toolName)
  if (binding === undefined) throw new Error(`${toolName}: missing operation binding`)
  return createBoundMcpOperationHandles({
    binding,
    invoke: forwardingOperationInvoker(calls, forward),
    observe: () => undefined,
  })
}

export function operationHandlesForInvoker(
  toolName: string,
  invoke: OperationInvoker,
): McpOperationHandles {
  const binding = bindingForTool(toolName)
  if (binding === undefined) throw new Error(`${toolName}: missing operation binding`)
  return createBoundMcpOperationHandles({
    binding,
    invoke,
    observe: () => undefined,
  })
}
