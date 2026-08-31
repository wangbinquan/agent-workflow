// RFC-345 T4b — bootstrap-owned binding for the current Intent lifecycle.

import {
  createLegacyIntentApplyResourceSession,
  type LegacyIntentApplyResourceDependencies,
  type LegacyIntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'

export function composeIntentApplyResourceBinding(
  dependencies: LegacyIntentApplyResourceDependencies,
) {
  return Object.freeze({
    createSession(options: LegacyIntentApplyResourceSessionOptions) {
      return createLegacyIntentApplyResourceSession(options, dependencies)
    },
  })
}
