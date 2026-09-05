import type { DbClient } from '@/db/client'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { SqliteMemoryDistillRuntimeResolver } from '@/modules/memory/infrastructure/memoryDistillRuntimeResolver'
import { createMemoryDistillSessionCapture } from '@/modules/memory/infrastructure/memoryDistillSessionCapture'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { enqueueDistillJob } from '@/modules/memory/application/distill/schedule'
import { appHome } from '@/util/paths'

export function createSqliteMemoryDistillTestContext(db: DbClient, root = appHome()) {
  const reviewedArtifacts = new DatabaseCommittedReviewArtifactReader(db, root)
  return Object.freeze({
    store: new DrizzleMemoryDistillWorkStore(db, createMemoryDistillSessionCapture(db)),
    runtimeResolver: new SqliteMemoryDistillRuntimeResolver(db),
    reviewedArtifacts,
  })
}

/** Provider-real test participant for consumers that only enqueue work. */
export function createSqliteMemoryDistillEnqueuer(db: DbClient): MemoryDistillEnqueuer {
  const store = new DrizzleMemoryDistillWorkStore(db, createMemoryDistillSessionCapture(db))
  return Object.freeze({
    enqueue: async (input) => await enqueueDistillJob(store, input),
  })
}
