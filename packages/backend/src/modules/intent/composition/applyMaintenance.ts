import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger, type Logger } from '@/util/log'
import {
  createIntentApplyArtifactLifecycle,
  createIntentApplyJournalConvergence,
  type IntentApplyJournalConvergence,
} from '../infrastructure/intentApplyArtifactLifecycle'
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
}): IntentApplyJournalConvergence {
  const log = input.log ?? createLogger('intentApplyMaintenance')
  return createIntentApplyJournalConvergence({
    db: input.db,
    artifacts: createIntentApplyArtifactLifecycle({
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
