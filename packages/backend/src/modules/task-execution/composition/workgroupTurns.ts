import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'
import type { WorkgroupClarifyAllowedPort } from '../application/ports/workgroupTurns'
import { createWorkgroupTurnsOperations } from '../engine/task/workgroup/workgroupTurns'
import {
  createWorkgroupTurnsPersistence,
  type WorkgroupHostLedgerParticipantFactory,
  type WorkgroupTurnsDependencies,
} from '../infrastructure/workgroupTurnsPersistence'

/**
 * RFC-359 W4-D19c —— 工作组回合一份装配。RFC-411：轮次驱动（engine/task/workgroup）与它的持久化适配器
 * （infrastructure/workgroupTurnsPersistence.ts）都归 task-execution；宿主账本工厂与反问许可判定由 bootstrap 交入。
 */
export function composeWorkgroupTurnsOperations(
  db: PersistenceDb,
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

/** The turn engine over the task-execution persistence adapter (the suites drive it with their own dependencies). */
export function createWorkgroupTurnsPersistenceOperations(
  dependencies: WorkgroupTurnsDependencies,
): WorkgroupTurnsOperations {
  return createWorkgroupTurnsOperations(createWorkgroupTurnsPersistence(dependencies))
}
