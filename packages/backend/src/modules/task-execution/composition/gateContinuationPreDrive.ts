import type { ProviderNeutralDatabase } from '@/db/query'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createClarifyContinuationConvergence } from '@/modules/collaboration/infrastructure/clarifyContinuationConvergence'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { createGateContinuationPreDriveStep } from '@/services/humanGateContinuationEffects'
import { createTaskExecutionPersistence } from './taskExecutionPersistence'

/** Both providers bind the same continuation, operation and convergence participants. */
export function composeGateContinuationPreDrive(input: {
  readonly db: ProviderNeutralDatabase
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}) {
  return createGateContinuationPreDriveStep({
    persistence: createTaskExecutionPersistence(input.db),
    humanGateOperations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(input.db)),
    clarifyConvergence: createClarifyContinuationConvergence(input),
  })
}
