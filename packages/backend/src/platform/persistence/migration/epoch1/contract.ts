// RFC-395 II-b V1: converter-owned schema; never follows the live registry at activation.
import { compileContract } from '../../schema/contract'
import type { LogicalSchemaContract } from '../../schema/contractTypes'
import { frozenEpoch1Registry } from './definitions'
import { projectLegacyV2 } from '../legacy/v2Contract'

export const frozenEpoch1Contract = projectLegacyV2(frozenEpoch1Registry)
export const frozenEpoch1ExplicitContract = compileContract(frozenEpoch1Registry)

/** Activation pins epoch-1 to its frozen provenance independently of the live registry. */
export const epoch1GuardMode = 'frozen-only' as const

export function assertFrozenEpoch1Contract(live: Pick<LogicalSchemaContract, 'digest'>): void {
  if (live.digest !== frozenEpoch1Contract.digest)
    throw new Error(
      'RFC-395 II-b V1: frozen epoch-1 contract changed. Update the frozen epoch-1 copy and the supported-source manifest together (migration §3).',
    )
}

export function buildFrozenEpoch1LogicalSchemaContract() {
  return frozenEpoch1Contract
}
