// RFC-491 — the runtime kinds' static protocol facts Task Execution reads, offered through `public/queries` (the same
// shape as `isRuntimeMcpTestEligible`): the kind registry's guard, a driver's static capability declaration and its
// "resume target session not found" stderr judgment. Pure reads of this module's own registry; an unknown kind throws
// from `getRuntimeDriver` exactly where the callers used to call it.
import { getRuntimeDriver, isKnownRuntimeKind } from '@/services/runtime'
import type { RuntimeKind } from '../public/types'
import type { RuntimeDriverCapabilities } from '../application/ports/agentProtocol'

export { isKnownRuntimeKind }

/** The driver's static capability declaration (observation source, declaration faces, inventory stance). */
export function runtimeDriverCapabilities(kind: RuntimeKind): RuntimeDriverCapabilities {
  return getRuntimeDriver(kind).capabilities
}

/** The driver's judgment that a resume target session does not exist; undefined when the driver cannot tell. */
export function detectRuntimeSessionNotFound(
  kind: RuntimeKind,
  stderrTail: string,
): boolean | undefined {
  return getRuntimeDriver(kind).detectSessionNotFound?.(stderrTail)
}
