import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { CodeHostEventContinuationPort } from '@/modules/integration/application/ports/codeHostEventResponse'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { shouldWakeForWebhook } from '../domain/webhookWake'
import type { MissionPersistence } from '../application/ports/missionStore'
import { createPostgresqlMissionPersistence } from './postgresqlMissionStore'
import { createSqliteMissionPersistence } from './sqliteMissionStore'

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

export function createSqliteMissionCodeHostEventContinuation(
  db: DbClient,
): CodeHostEventContinuationPort {
  return continuationFrom(createSqliteMissionPersistence(db))
}

export function createPostgresqlMissionCodeHostEventContinuation(
  db: PostgresqlDatabaseClient,
): CodeHostEventContinuationPort {
  return continuationFrom(createPostgresqlMissionPersistence(db))
}
