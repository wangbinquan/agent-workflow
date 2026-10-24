// RFC-395 II-b O3 — System Operations retains only the recovery audit append.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { bumpRecoveryCounter } from '@/services/recovery'
import { createLogger } from '@/util/log'
import type {
  ResourceLimitAudit,
  ResourceLimitCancellationAudit,
} from '../application/ports/resourceLimitAudit'

const log = createLogger('resource-limits')

export function createResourceLimitAudit(db: PersistenceDb): ResourceLimitAudit {
  return {
    async recordLimitCancellation(input: ResourceLimitCancellationAudit): Promise<void> {
      bumpRecoveryCounter('limit-cancel')
      try {
        const { recoveryEvents } = tablesOf(db)
        await insertOne(db, recoveryEvents, {
          id: ulid(),
          taskId: input.taskId,
          nodeRunId: null,
          actor: 'system',
          kind: 'limit-cancel',
          reason: input.reason,
          beforeJson: JSON.stringify({ status: 'running' }),
          afterJson: JSON.stringify({ status: 'canceled' }),
          createdAt: input.now,
        })
      } catch (error) {
        log.warn('resource-limit recovery audit dropped', { error: String(error) })
      }
    },
  }
}
