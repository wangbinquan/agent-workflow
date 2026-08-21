import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'

import { EXECUTION_CONTRACT_RESULT_PORT } from '../domain/model'

function hasExecutionContractDeclarations(frontmatterExtra: Record<string, unknown>): boolean {
  const declarations = frontmatterExtra.executionContracts
  return (
    Array.isArray(declarations) &&
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        declaration !== null &&
        typeof declaration === 'object' &&
        !Array.isArray(declaration) &&
        typeof (declaration as Record<string, unknown>).contractId === 'string' &&
        ((declaration as Record<string, unknown>).contractId as string).length > 0 &&
        typeof (declaration as Record<string, unknown>).version === 'number' &&
        Number.isInteger((declaration as Record<string, unknown>).version) &&
        ((declaration as Record<string, unknown>).version as number) > 0,
    )
  )
}

function canonicalOutputs(outputs: readonly string[], active: boolean): string[] {
  const ordinary = outputs.filter((port) => port !== EXECUTION_CONTRACT_RESULT_PORT)
  return active ? [...ordinary, EXECUTION_CONTRACT_RESULT_PORT] : ordinary
}

function withoutManagedMapEntry<T extends string>(
  patched: Record<string, T> | undefined,
  existing: Record<string, T> | undefined,
): Record<string, T> | undefined {
  const source = patched ?? existing
  if (source === undefined) return undefined
  if (patched === undefined && !(EXECUTION_CONTRACT_RESULT_PORT in source)) return undefined
  const next = { ...source }
  delete next[EXECUTION_CONTRACT_RESULT_PORT]
  return next
}

function withoutManagedBranchPort(
  patched: string[] | undefined,
  existing: string[] | undefined,
): string[] | undefined {
  const source = patched ?? existing
  if (source === undefined) return undefined
  if (patched === undefined && !source.includes(EXECUTION_CONTRACT_RESULT_PORT)) return undefined
  return source.filter((port) => port !== EXECUTION_CONTRACT_RESULT_PORT)
}

/**
 * The execution-contract platform owns its Agent result port. A create path
 * may not persist a declaration without that port, duplicate it, or attach
 * editable output sidecars to it.
 */
export function reconcileCreatedAgentExecutionContractPorts(input: CreateAgent): CreateAgent {
  if (!hasExecutionContractDeclarations(input.frontmatterExtra)) return input
  return {
    ...input,
    outputs: canonicalOutputs(input.outputs, true),
    outputKinds: withoutManagedMapEntry(input.outputKinds, undefined),
    outputWrapperPortNames: withoutManagedMapEntry(input.outputWrapperPortNames, undefined),
    branchPorts: withoutManagedBranchPort(input.branchPorts, undefined),
  }
}

/**
 * Reconcile the sparse update against the persisted Agent. While at least one
 * contract is declared, `agent-result` is present exactly once and has no
 * independently editable sidecars. Removing the final declaration removes the
 * managed port in the same write.
 */
export function reconcileUpdatedAgentExecutionContractPorts(
  existing: Agent,
  patch: UpdateAgent,
): UpdateAgent {
  const before = hasExecutionContractDeclarations(existing.frontmatterExtra)
  const after = hasExecutionContractDeclarations(
    patch.frontmatterExtra ?? existing.frontmatterExtra,
  )
  if (!before && !after) return patch

  const next: UpdateAgent = {
    ...patch,
    outputs: canonicalOutputs(patch.outputs ?? existing.outputs, after),
  }
  const outputKinds = withoutManagedMapEntry(patch.outputKinds, existing.outputKinds)
  const outputWrapperPortNames = withoutManagedMapEntry(
    patch.outputWrapperPortNames,
    existing.outputWrapperPortNames,
  )
  const branchPorts = withoutManagedBranchPort(patch.branchPorts, existing.branchPorts)
  if (outputKinds !== undefined) next.outputKinds = outputKinds
  if (outputWrapperPortNames !== undefined) next.outputWrapperPortNames = outputWrapperPortNames
  if (branchPorts !== undefined) next.branchPorts = branchPorts
  return next
}
