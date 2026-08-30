// RFC-344 — binding-scoped typed handles exposed to MCP tool adapters.

import { bindingAllows, MCP_OPERATIONS, type McpHttpOperation } from '@/mcp/operationBindings'
import type {
  HttpOperationInput,
  McpOperationBinding,
  OperationInvoker,
  OperationResult,
} from '@/platform/operations/contracts'

type NamedHandles = {
  readonly [K in keyof typeof MCP_OPERATIONS]: (
    input?: HttpOperationInput,
  ) => Promise<OperationResult>
}

export type McpOperationHandles = NamedHandles & {
  /** Closed composite/parameterized dependency selected from the binding table. */
  readonly dependency: (
    operation: McpHttpOperation,
    input?: HttpOperationInput,
  ) => Promise<OperationResult>
}

export function createBoundMcpOperationHandles(input: {
  readonly binding: McpOperationBinding
  readonly invoke: OperationInvoker
  readonly observe: (result: OperationResult) => void
}): McpOperationHandles {
  const run = async (
    operation: McpHttpOperation,
    operationInput?: HttpOperationInput,
  ): Promise<OperationResult> => {
    if (!bindingAllows(input.binding, operation.id)) {
      throw new Error(
        `${input.binding.toolName}: undeclared operation dependency '${operation.id}'`,
      )
    }
    const result = await input.invoke(operation.id, operationInput)
    input.observe(result)
    return result
  }
  const named = Object.fromEntries(
    Object.entries(MCP_OPERATIONS).map(([name, operation]) => [
      name,
      (operationInput?: HttpOperationInput) => run(operation, operationInput),
    ]),
  ) as NamedHandles
  return Object.freeze({
    ...named,
    dependency: run,
  })
}
