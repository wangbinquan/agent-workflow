// RFC-384: daemon queued recovery enters Intent through its composition boundary.
import {
  resumeQueuedIntentWorkingSets as resumeWorkingSets,
  type IntentDispatchDeps,
} from '../application/dispatcher'

export type { IntentDispatchDeps }

export async function resumeQueuedIntentWorkingSets(
  dependencies: IntentDispatchDeps,
  sessionIds: readonly string[],
): Promise<void> {
  if (sessionIds.length === 0) return
  await resumeWorkingSets(dependencies, sessionIds)
}
