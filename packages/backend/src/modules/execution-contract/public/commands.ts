import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'

import { EXECUTION_CONTRACT_RESULT_PORT } from '../domain/model'

interface ManagedContractPort {
  readonly name: string
  readonly kind: string | null
}

function executionContractPorts(
  frontmatterExtra: Record<string, unknown>,
): ManagedContractPort[] | null {
  const declarations = frontmatterExtra.executionContracts
  if (!Array.isArray(declarations) || declarations.length === 0) return []
  const ports = new Map<string, ManagedContractPort>()
  for (const declaration of declarations) {
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      return null
    }
    const value = declaration as Record<string, unknown>
    if (
      typeof value.contractId !== 'string' ||
      value.contractId.length === 0 ||
      typeof value.version !== 'number' ||
      !Number.isInteger(value.version) ||
      value.version <= 0 ||
      (value.outputPort !== undefined &&
        (typeof value.outputPort !== 'string' || value.outputPort.length === 0)) ||
      (value.outputKind !== undefined &&
        (typeof value.outputKind !== 'string' || value.outputKind.length === 0))
    ) {
      return null
    }
    const name = (value.outputPort as string | undefined) ?? EXECUTION_CONTRACT_RESULT_PORT
    const kind = (value.outputKind as string | undefined) ?? null
    const previous = ports.get(name)
    ports.set(name, { name, kind: previous?.kind ?? kind })
  }
  return [...ports.values()]
}

function canonicalOutputs(
  outputs: readonly string[],
  before: readonly ManagedContractPort[],
  after: readonly ManagedContractPort[],
): string[] {
  const managed = new Set([...before, ...after].map((port) => port.name))
  const ordinary = outputs.filter((port) => !managed.has(port))
  return [...new Set([...ordinary, ...after.map((port) => port.name)])]
}

function reconcileManagedMap<T extends string>(
  patched: Record<string, T> | undefined,
  existing: Record<string, T> | undefined,
  before: readonly ManagedContractPort[],
  after: readonly ManagedContractPort[],
  managedValues?: ReadonlyMap<string, T>,
): Record<string, T> | undefined {
  const source = patched ?? existing
  if (source === undefined && (managedValues?.size ?? 0) === 0) return undefined
  const next = { ...(source ?? {}) }
  for (const port of [...before, ...after]) delete next[port.name]
  for (const [name, value] of managedValues ?? []) next[name] = value
  return next
}

function withoutManagedBranchPorts(
  patched: string[] | undefined,
  existing: string[] | undefined,
  before: readonly ManagedContractPort[],
  after: readonly ManagedContractPort[],
): string[] | undefined {
  const source = patched ?? existing
  if (source === undefined) return undefined
  const managed = new Set([...before, ...after].map((port) => port.name))
  return source.filter((port) => !managed.has(port))
}

/**
 * The execution-contract platform owns its Agent result port. A create path
 * may not persist a declaration without that port, duplicate it, or attach
 * editable output sidecars to it.
 */
export function reconcileCreatedAgentExecutionContractPorts(input: CreateAgent): CreateAgent {
  const after = executionContractPorts(input.frontmatterExtra)
  if (after === null || after.length === 0) return input
  const outputKinds = new Map(
    after.flatMap((port) => (port.kind === null ? [] : [[port.name, port.kind] as const])),
  )
  return {
    ...input,
    outputs: canonicalOutputs(input.outputs, [], after),
    outputKinds: reconcileManagedMap(input.outputKinds, undefined, [], after, outputKinds),
    outputWrapperPortNames: reconcileManagedMap(input.outputWrapperPortNames, undefined, [], after),
    branchPorts: withoutManagedBranchPorts(input.branchPorts, undefined, [], after),
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
  const before = executionContractPorts(existing.frontmatterExtra)
  const after = executionContractPorts(patch.frontmatterExtra ?? existing.frontmatterExtra)
  if (before === null || after === null || (before.length === 0 && after.length === 0)) return patch
  const outputKindsByPort = new Map(
    after.flatMap((port) => (port.kind === null ? [] : [[port.name, port.kind] as const])),
  )

  const next: UpdateAgent = {
    ...patch,
    outputs: canonicalOutputs(patch.outputs ?? existing.outputs, before, after),
  }
  const outputKinds = reconcileManagedMap(
    patch.outputKinds,
    existing.outputKinds,
    before,
    after,
    outputKindsByPort,
  )
  const outputWrapperPortNames = reconcileManagedMap(
    patch.outputWrapperPortNames,
    existing.outputWrapperPortNames,
    before,
    after,
  )
  const branchPorts = withoutManagedBranchPorts(
    patch.branchPorts,
    existing.branchPorts,
    before,
    after,
  )
  if (outputKinds !== undefined) next.outputKinds = outputKinds
  if (outputWrapperPortNames !== undefined) next.outputWrapperPortNames = outputWrapperPortNames
  if (branchPorts !== undefined) next.branchPorts = branchPorts
  return next
}
