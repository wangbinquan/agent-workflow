import type { RunSlot } from './slots'

export type SyntheticOwner = Extract<RunSlot, { kind: 'synthetic' }>['owner']
export const SYNTHETIC_OWNER_VERSION = 'so1' as const

/** The owner positions mirror rs1; kind and id remain separate, unnormalized values. */
export function encodeSyntheticOwner(owner: SyntheticOwner): string {
  if ((owner.kind !== 'task' && owner.kind !== 'attempt') || typeof owner.id !== 'string')
    throw new Error('invalid-synthetic-owner')
  return JSON.stringify([SYNTHETIC_OWNER_VERSION, owner.kind, owner.id])
}

export function decodeSyntheticOwner(encoded: string): SyntheticOwner {
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error('invalid-synthetic-owner')
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== SYNTHETIC_OWNER_VERSION ||
    (value[1] !== 'task' && value[1] !== 'attempt') ||
    typeof value[2] !== 'string'
  )
    throw new Error('invalid-synthetic-owner')
  const owner: SyntheticOwner = { kind: value[1], id: value[2] }
  if (encodeSyntheticOwner(owner) !== encoded) throw new Error('invalid-synthetic-owner')
  return owner
}
