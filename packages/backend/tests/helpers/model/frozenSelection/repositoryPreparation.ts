// Frozen from 67ab6b9aed08d97dcd6d3d9dfb57b8885a11f8e6. Query bodies are verbatim HEAD, with their original bindings.
// S6: services/task.ts; S7: infrastructure/repositoryPreparationRetryCommand.ts.
import { and, desc, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
const REPO_PREP_NODE_ID = '__repo_prep__'

export async function frozenS6(input: { deps: { db: PersistenceDb } }, taskId: string) {
  const { nodeRuns } = tablesOf(input.deps.db)
  const latestPrep = (
    await input.deps.db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
      .orderBy(
        desc(nodeRuns.retryIndex),
        engineOf(input.deps.db).descNullsLast(nodeRuns.seq),
        desc(nodeRuns.id),
      )
      .limit(1)
  )[0]
  return latestPrep
}

export async function frozenS7(dependencies: { db: PersistenceDb }, taskId: string) {
  const { nodeRuns } = tablesOf(dependencies.db)
  const prepRows = await dependencies.db
    .select({ id: nodeRuns.id, retryIndex: nodeRuns.retryIndex, status: nodeRuns.status })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
    .orderBy(
      desc(nodeRuns.retryIndex),
      engineOf(dependencies.db).descNullsLast(nodeRuns.seq),
      desc(nodeRuns.id),
    )
    .limit(1)
  const prep = prepRows[0]
  return prep
}
