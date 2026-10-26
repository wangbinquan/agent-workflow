import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { QuiescePort } from '../../application/ports/epochSwitch'
import { EpochSwitchError } from '../../domain/epochSwitch/model'

export interface HostedFreezeAcknowledgement {
  operationId: string
  reference: string
  sourceGenerationId: string
  writersStopped: boolean
}
export function createHostedEpochFreeze(input: {
  acknowledgement: HostedFreezeAcknowledgement
  now?: () => number
  verify(ack: HostedFreezeAcknowledgement): Promise<boolean>
}): QuiescePort {
  const assert = async (op: string) => {
    if (
      input.acknowledgement.operationId !== op ||
      !input.acknowledgement.writersStopped ||
      !input.acknowledgement.reference ||
      !(await input.verify(input.acknowledgement))
    )
      throw new EpochSwitchError('v3-hosted-freeze-required', {
        category: 'freeze-failed',
        retryable: true,
      })
  }
  return {
    async quiesce({ operationId }) {
      await assert(operationId)
      const payload = {
        version: 1 as const,
        operationId,
        deployment: 'crewstation' as const,
        kind: 'platform-frozen' as const,
        stoppedAt: (input.now ?? Date.now)(),
        freezeReference: input.acknowledgement.reference,
      }
      return { ...payload, digest: valueDigest(payload) }
    },
    assertHeld: assert,
    async release() {
      /* The platform owns the freeze across Job exits. */
    },
  }
}
