// RFC-349 — provider-neutral human-gate park command.

import type { PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import type { OwnershipToken } from '../domain/ownership'
import type {
  HumanGateTaskLifecycle,
  HumanGateTaskParkResult,
} from './ports/humanGateTaskLifecycle'

export type ParkTaskAtHumanGateResult = HumanGateTaskParkResult

export async function parkTaskAtHumanGate(
  persistence: HumanGateTaskLifecycle,
  input: {
    readonly prepared: PreparedHumanGateRef
    readonly token?: OwnershipToken
    readonly now?: number
  },
): Promise<ParkTaskAtHumanGateResult> {
  return await persistence.parkPrepared({
    prepared: input.prepared,
    ...(input.token === undefined ? {} : { token: input.token }),
    now: input.now ?? Date.now(),
  })
}
