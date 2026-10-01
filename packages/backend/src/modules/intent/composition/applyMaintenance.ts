import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger, type Logger } from '@/util/log'
import {
  createIntentApplyJournalConvergence,
  type IntentApplyJournalConvergence,
} from '../infrastructure/intentApplyArtifactLifecycle'
import type { IntentApplyArtifactLifecycle } from '../infrastructure/intentApplyEngine'
import type { IntentArtifactContentPort } from '../application/ports/intentArtifactContent'
import type { LegacyIntentSkillArtifactCompat } from '../ports/skillArtifactCompensation'
import { composeIntentApplyArtifactLifecycle } from './apply'

/** Recovery-only composition (both providers); it never constructs apply resources. */
export function composeIntentApplyConvergence(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly pluginsDir: string
  readonly artifacts?: IntentApplyArtifactLifecycle
  readonly content?: IntentArtifactContentPort
  readonly legacySkillArtifacts?: LegacyIntentSkillArtifactCompat
  readonly now?: () => number
  readonly log?: Logger
}): IntentApplyJournalConvergence {
  const log = input.log ?? createLogger('intentApplyMaintenance')
  return createIntentApplyJournalConvergence({
    db: input.db,
    artifacts: input.artifacts ?? composeIntentApplyArtifactLifecycle(input),
    ...(input.now === undefined ? {} : { now: input.now }),
    log,
  })
}
