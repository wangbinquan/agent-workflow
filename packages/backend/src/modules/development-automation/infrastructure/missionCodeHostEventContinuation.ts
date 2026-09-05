import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { CodeHostEventContinuationPort } from '@/modules/integration/application/ports/codeHostEventResponse'
import { shouldWakeForWebhook } from '../domain/webhookWake'
import type { MissionPersistence } from '../application/ports/missionStore'
import { createMissionPersistence } from './missionStore'

/**
 * Development Automation's narrow Event Center participant. It translates an
 * already-normalized code-host MR identity into a durable Mission wake hint;
 * no Webhook route or integration adapter reaches Mission tables directly.
 */
function continuationFrom(
  store: Pick<MissionPersistence, 'findMrClaim' | 'getMission' | 'recordWakeHint'>,
): CodeHostEventContinuationPort {
  return {
    async match(input) {
      const claim = await store.findMrClaim({
        codeHostEndpointRef: input.provider,
        stableProjectRef: input.repoPath,
        mrIid: input.mrIid,
      })
      if (claim === null) return null
      const mission = await store.getMission(claim.missionId)
      if (mission === null) return null
      if (
        !shouldWakeForWebhook({
          claimState: claim.state,
          missionTerminalKind: mission.terminalKind,
        })
      ) {
        return null
      }
      return {
        continuationRef: mission.id,
        definitionRevision: claim.id,
        displayName: {
          'zh-CN': `继续开发任务 ${mission.id}`,
          'en-US': `Continue development mission ${mission.id}`,
        },
      }
    },
    async consume(input) {
      await store.recordWakeHint({
        id: ulid(),
        missionId: input.continuationRef,
        source: 'webhook',
        deliveryKey: `event-center:${input.eventDeliveryId}`,
        now: input.occurredAt,
      })
    },
  }
}

/** 两个 provider 同一份（RFC-359 W4-D10）。 */
export function createMissionCodeHostEventContinuation(
  db: ProviderNeutralDatabase,
): CodeHostEventContinuationPort {
  return continuationFrom(createMissionPersistence(db))
}
