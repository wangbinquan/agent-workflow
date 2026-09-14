import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger, type Logger } from '@/util/log'
import {
  createPostgresqlIntentApplyArtifactLifecycle,
  createPostgresqlIntentApplyJournalConvergence,
  type PostgresqlIntentApplyJournalConvergence,
} from '../infrastructure/postgresqlIntentApplyArtifactLifecycle'
import {
  composeLegacyIntentSkillArtifactCompat,
  composePostgresqlSkillArtifactCompensation,
} from '@/modules/resource-catalog/composition/intentApply'

/** Recovery-only composition (both providers); it never constructs apply resources. */
export function composeIntentApplyConvergence(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly pluginsDir: string
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlIntentApplyJournalConvergence {
  const log = input.log ?? createLogger('intentApplyMaintenance')
  return createPostgresqlIntentApplyJournalConvergence({
    db: input.db,
    artifacts: createPostgresqlIntentApplyArtifactLifecycle({
      skillArtifacts: composePostgresqlSkillArtifactCompensation(),
      legacySkillArtifacts: composeLegacyIntentSkillArtifactCompat(),
      db: input.db,
      appHome: input.appHome,
      pluginsDir: input.pluginsDir,
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
    log,
  })
}
