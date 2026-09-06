import type { ProviderNeutralDatabase } from '@/db/query'
import type { WorkgroupTurnsOperations } from '@/modules/task-execution/public/commands'
import type { WorkgroupClarifyAllowedPort } from '../application/workgroups/workgroupTurnsDriver'
import {
  createWorkgroupTurnsPersistenceOperations,
  type WorkgroupHostLedgerParticipantFactory,
} from '../infrastructure/workgroupTurnsOperations'

/**
 * RFC-359 W4-D19c —— 工作组回合一份装配（此前 SQLite 走 legacy engine、PG 走这条中立驱动）。
 * 跨上下文的装配持有 TaskExecution 的宿主账本工厂，Resource Catalog 的适配器负责预留并共享事务。
 */
export function composeWorkgroupTurnsOperations(
  db: ProviderNeutralDatabase,
  hostLedgerFactory: WorkgroupHostLedgerParticipantFactory,
  clarifyAskGate: WorkgroupClarifyAllowedPort,
): WorkgroupTurnsOperations {
  return createWorkgroupTurnsPersistenceOperations({
    db,
    hostLedgerFactory: {
      inTransaction: (transaction) => hostLedgerFactory.inTransaction(transaction),
    },
    clarifyAskGate,
  })
}
