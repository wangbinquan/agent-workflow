import { createIntentApplyRecoveryScene } from '../infrastructure/intentApplyRecovery'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger, type Logger } from '@/util/log'
import type { IntentApplyArtifactLifecycle } from '../infrastructure/intentApplyEngine'

/** Recovery-only composition (both providers); it never constructs apply resources. */
export function composeIntentApplyRecoveryScene(input: {
  readonly db: PersistenceDb
  /** RFC-523: the caller composes the artifact lifecycle (the worker with the hosted or the standalone content). */
  readonly artifacts: IntentApplyArtifactLifecycle
  readonly now?: () => number
  readonly log?: Logger
}) {
  const log = input.log ?? createLogger('intentApplyMaintenance')
  return createIntentApplyRecoveryScene({
    db: input.db,
    artifacts: input.artifacts,
    ...(input.now === undefined ? {} : { now: input.now }),
    log,
  })
}
