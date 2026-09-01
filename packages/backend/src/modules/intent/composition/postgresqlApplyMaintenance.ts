import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger, type Logger } from '@/util/log'
import {
  createPostgresqlIntentApplyArtifactLifecycle,
  createPostgresqlIntentApplyJournalConvergence,
  type PostgresqlIntentApplyJournalConvergence,
} from '../infrastructure/postgresqlIntentApplyArtifactLifecycle'

/** Recovery-only PostgreSQL composition; it never constructs apply resources. */
export function composePostgresqlIntentApplyConvergence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly pluginsDir: string
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlIntentApplyJournalConvergence {
  const log = input.log ?? createLogger('intentApplyMaintenance')
  return createPostgresqlIntentApplyJournalConvergence({
    db: input.db,
    artifacts: createPostgresqlIntentApplyArtifactLifecycle({
      db: input.db,
      appHome: input.appHome,
      pluginsDir: input.pluginsDir,
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
    log,
  })
}
