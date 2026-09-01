import type { DbClient } from '../../src/db/client'
import { SqliteNodeExecutionPersistence } from '../../src/modules/task-execution/infrastructure/sqliteNodeExecutionPersistence'
import { SqliteNodeRunLifecyclePersistence } from '../../src/modules/task-execution/infrastructure/sqliteNodeRunLifecyclePersistence'
import { SqliteTaskExecutionEffectPersistence } from '../../src/modules/task-execution/infrastructure/sqliteTaskExecutionEffectPersistence'
import type { CommitPushDeps } from '../../src/services/commitPushRunner'
import { createTestRepositoryPublicationTransport } from './taskExecutionTestTopology'

type CommitPushTestOverrides = Partial<
  Pick<CommitPushDeps, 'log' | 'publicationTransport' | 'runGit'>
>

/** Test topology for the same provider-selected ports daemon bootstrap injects. */
export function composeSqliteCommitPushDeps(
  db: DbClient,
  overrides: CommitPushTestOverrides = {},
): CommitPushDeps {
  return {
    nodeRuns: new SqliteNodeRunLifecyclePersistence(db),
    nodeExecution: new SqliteNodeExecutionPersistence(db),
    effects: new SqliteTaskExecutionEffectPersistence(db),
    publicationTransport:
      overrides.publicationTransport ?? createTestRepositoryPublicationTransport(overrides.runGit),
    ...(overrides.runGit === undefined ? {} : { runGit: overrides.runGit }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  }
}
