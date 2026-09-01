import type { DbClient } from '@/db/client'
import { SqliteCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/sqliteCommittedReviewArtifactReader'
import { SqliteMemoryDistillRuntimeResolver } from '@/modules/memory/infrastructure/memoryDistillRuntimeResolver'
import { createSqliteMemoryDistillSessionCapture } from '@/modules/memory/infrastructure/memoryDistillSessionCapture'
import { SqliteMemoryDistillWorkStore } from '@/modules/memory/infrastructure/sqliteMemoryDistillWorkStore'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { appHome } from '@/util/paths'

export function createSqliteMemoryDistillTestContext(db: DbClient, root = appHome()) {
  const reviewedArtifacts = new SqliteCommittedReviewArtifactReader(db, root)
  return Object.freeze({
    store: new SqliteMemoryDistillWorkStore(db, createSqliteMemoryDistillSessionCapture(db)),
    runtimeResolver: new SqliteMemoryDistillRuntimeResolver(db),
    reviewedArtifacts,
  })
}

/** Provider-real test participant for consumers that only enqueue work. */
export function createSqliteMemoryDistillEnqueuer(db: DbClient): MemoryDistillEnqueuer {
  const store = new SqliteMemoryDistillWorkStore(db, createSqliteMemoryDistillSessionCapture(db))
  return Object.freeze({
    enqueue: async (input) => await enqueueDistillJob(store, input),
  })
}
