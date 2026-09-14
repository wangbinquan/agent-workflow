import type { ProviderNeutralDatabase } from '../../src/db/query'
import { DrizzleNodeExecutionPersistence } from '../../src/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from '../../src/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleTaskExecutionEffectPersistence } from '../../src/modules/task-execution/infrastructure/taskExecutionEffectPersistence'
import type { CommitPushDeps } from '../../src/services/commitPushRunner'
import { createTestRepositoryPublicationTransport } from './taskExecutionTestTopology'

type CommitPushTestOverrides = Partial<
  Pick<CommitPushDeps, 'log' | 'publicationTransport' | 'runGit'>
>

/**
 * Test topology for the same provider-selected ports daemon bootstrap injects.
 *
 * RFC-359 AC-6: the three Drizzle persistence adapters already take
 * `ProviderNeutralDatabase` (one implementation, both engines), so this composer
 * accepts the neutral handle too — a `DbClient` still satisfies it, and a
 * `describeEachProvider` harness can now hand it the PostgreSQL client.
 */
export function composeSqliteCommitPushDeps(
  db: ProviderNeutralDatabase,
  overrides: CommitPushTestOverrides = {},
): CommitPushDeps {
  return {
    nodeRuns: new DrizzleNodeRunLifecyclePersistence(db),
    nodeExecution: new DrizzleNodeExecutionPersistence(db),
    effects: new DrizzleTaskExecutionEffectPersistence(db),
    publicationTransport:
      overrides.publicationTransport ?? createTestRepositoryPublicationTransport(overrides.runGit),
    ...(overrides.runGit === undefined ? {} : { runGit: overrides.runGit }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  }
}
