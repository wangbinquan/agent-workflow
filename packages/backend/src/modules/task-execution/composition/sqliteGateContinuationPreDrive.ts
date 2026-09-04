import type { DbClient } from '@/db/client'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createSqliteClarifyContinuationConvergence } from '@/modules/collaboration/infrastructure/sqliteClarifyContinuationConvergence'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { createGateContinuationPreDriveStep } from '@/services/humanGateContinuationEffects'
import { createSqliteTaskExecutionPersistence } from './taskExecutionPersistence'

/** Legacy bootstrap compatibility. Provider-aware composition should inject
 * the three Promise participants directly into createGateContinuationPreDriveStep. */
export function createSqliteGateContinuationPreDriveStep(input: {
  readonly db: DbClient
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}) {
  return createGateContinuationPreDriveStep({
    persistence: createSqliteTaskExecutionPersistence(input.db),
    humanGateOperations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(input.db)),
    clarifyConvergence: createSqliteClarifyContinuationConvergence(input),
  })
}
