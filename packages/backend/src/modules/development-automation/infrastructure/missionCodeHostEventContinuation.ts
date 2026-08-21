import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { shouldWakeForWebhook } from '../domain/webhookWake'
import { createSqliteMissionStore } from './sqliteMissionStore'

/**
 * Development Automation's narrow Event Center participant. It translates an
 * already-normalized code-host MR identity into a durable Mission wake hint;
 * no Webhook route or integration adapter reaches Mission tables directly.
 */
export function createSqliteMissionCodeHostEventContinuation(db: DbClient) {
  const store = createSqliteMissionStore(db)
  return {
    match(input: { readonly provider: string; readonly repoPath: string; readonly mrIid: string }) {
      const claim = store.findMrClaim({
        codeHostEndpointRef: input.provider,
        stableProjectRef: input.repoPath,
        mrIid: input.mrIid,
      })
      if (claim === null) return null
      const mission = store.getMission(claim.missionId)
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
    consume(input: {
      readonly continuationRef: string
      readonly eventDeliveryId: string
      readonly occurredAt: number
    }) {
      store.recordWakeHint({
        id: ulid(),
        missionId: input.continuationRef,
        source: 'webhook',
        deliveryKey: `event-center:${input.eventDeliveryId}`,
        now: input.occurredAt,
      })
    },
  }
}
