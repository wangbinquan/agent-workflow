import { createHumanGatePersistenceParticipantInTx } from '../infrastructure/humanGatePersistenceParticipant'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createClarifyContinuationConvergence } from '@/modules/collaboration/infrastructure/clarifyContinuationConvergence'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { createGateContinuationPreDriveStep } from '@/services/humanGateContinuationEffects'
import { createTaskExecutionPersistence } from './taskExecutionPersistence'

/** Both providers bind the same continuation, operation and convergence participants. */
export function composeGateContinuationPreDrive(input: {
  readonly persistence?: ReturnType<typeof createTaskExecutionPersistence>
  readonly db: PersistenceDb
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}) {
  return createGateContinuationPreDriveStep({
    persistence: input.persistence ?? createTaskExecutionPersistence(input.db),
    humanGateOperations: new DatabaseHumanGateOperationPersistence(
      databaseSessionFor(input.db),
      createHumanGatePersistenceParticipantInTx,
    ),
    clarifyConvergence: createClarifyContinuationConvergence(input),
  })
}
