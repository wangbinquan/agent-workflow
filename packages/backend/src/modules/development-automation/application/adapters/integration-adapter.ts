// RFC-555 (RFC-294 S9 step 10): Development Automation's designated adapter for Integration's consumer-owned required
// ports (`@/modules/integration/composition/required-ports`, type-only). It implements the code-host event continuation
// from Mission's MR claims; `infrastructure/missionCodeHostEventContinuation.ts` only binds the database. The logic moved
// here from that file unchanged.
import { ulid } from 'ulid'

import type { CodeHostEventContinuationPort } from '@/modules/integration/composition/required-ports'
import { shouldWakeForWebhook } from '../../domain/webhookWake'
import type { MissionPersistence } from '../ports/missionStore'

/**
 * Development Automation's narrow Event Center participant. It translates an
 * already-normalized code-host MR identity into a durable Mission wake hint;
 * no Webhook route or integration adapter reaches Mission tables directly.
 */
export function missionCodeHostEventContinuation(
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
