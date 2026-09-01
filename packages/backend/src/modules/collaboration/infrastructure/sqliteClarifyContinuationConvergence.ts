import type { DbClient } from '@/db/client'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { finishCommittedClarifyAutoDispatch } from '@/services/clarify/autoDispatch'
import type {
  ClarifyContinuationConvergence,
  ClarifyContinuationConvergenceRequest,
} from '../application/ports/clarifyContinuationConvergence'

/** SQLite compatibility adapter. The clarify command is being migrated behind
 * this collaboration-owned Promise port; task execution no longer imports its
 * storage mechanism or memory scheduler. */
export function createSqliteClarifyContinuationConvergence(input: {
  readonly db: DbClient
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}): ClarifyContinuationConvergence {
  return Object.freeze({
    async finish(request: ClarifyContinuationConvergenceRequest) {
      await finishCommittedClarifyAutoDispatch({
        db: input.db,
        memoryDistillEnqueuer: input.memoryDistillEnqueuer,
        ...request,
      })
    },
  })
}
