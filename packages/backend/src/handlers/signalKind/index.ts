// RFC-061 PR-B — SignalKindHandler registry.
//
// One entry per RFC-061 SignalKind (6 closed kinds). The `satisfies
// Record<SignalKind, ...>` clause is the compile-time exhaustiveness
// check that prevents adding a SignalKind to the union without
// registering a handler.
//
// `await-external-data` is registered as a throw-on-use stub (design.md
// §4 reserves it for future work); the other 5 are production handlers.

import type { SignalKind, SignalKindHandler } from '@agent-workflow/shared'

import { awaitExternalDataSignalKindHandler } from './awaitExternalData'
import { crossClarifySignalKindHandler } from './crossClarify'
import { retryPendingAutoSignalKindHandler } from './retryPendingAuto'
import { retryPendingHumanSignalKindHandler } from './retryPendingHuman'
import { reviewSignalKindHandler } from './review'
import { selfClarifySignalKindHandler } from './selfClarify'

export const SIGNAL_KIND_HANDLERS = {
  'self-clarify': selfClarifySignalKindHandler,
  'cross-clarify': crossClarifySignalKindHandler,
  review: reviewSignalKindHandler,
  'retry-pending-auto': retryPendingAutoSignalKindHandler,
  'retry-pending-human': retryPendingHumanSignalKindHandler,
  'await-external-data': awaitExternalDataSignalKindHandler,
} satisfies { [K in SignalKind]: SignalKindHandler<K> }

export type RegisteredSignalKindHandlers = typeof SIGNAL_KIND_HANDLERS

export {
  awaitExternalDataSignalKindHandler,
  crossClarifySignalKindHandler,
  retryPendingAutoSignalKindHandler,
  retryPendingHumanSignalKindHandler,
  reviewSignalKindHandler,
  selfClarifySignalKindHandler,
}
