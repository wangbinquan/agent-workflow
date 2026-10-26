import type { EpochTargetLocation } from '@/platform/persistence/migration/run/types'
import type { ActivationPort } from '../../application/ports/epochSwitch'
import { EpochSwitchError } from '../../domain/epochSwitch/model'

export interface HostedEpochSwitchControl {
  prepared(input: {
    operationId: string
    generationId: string
    receiptDigest: string
    location: EpochTargetLocation
  }): Promise<void>
  observe(operationId: string): ReturnType<ActivationPort['observe']>
  rollback(): Promise<void>
}

export function createHostedEpochActivation(control: HostedEpochSwitchControl): ActivationPort {
  return {
    async activate({ journal, receiptDigest, pointer }) {
      if (
        pointer !== null ||
        journal.payload.deployment !== 'crewstation' ||
        !journal.payload.target.generationId ||
        !journal.payload.target.location
      )
        throw new EpochSwitchError('v3-hosted-activation-binding')
      await control.prepared({
        operationId: journal.payload.operationId,
        generationId: journal.payload.target.generationId,
        receiptDigest,
        location: journal.payload.target.location,
      })
      return { pointerDigest: null }
    },
    observe: (op) => control.observe(op),
    async restorePrevious({ firstLiveWriteAt }) {
      if (firstLiveWriteAt !== null)
        throw new EpochSwitchError('reverse-migration-required', {
          category: 'reverse-migration-required',
        })
      await control.rollback()
    },
  }
}
