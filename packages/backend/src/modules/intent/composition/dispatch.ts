// RFC-384: daemon queued recovery enters Intent through its composition boundary.
import {
  resumeQueuedIntentWorkingSets as resumeWorkingSets,
  type IntentDispatchDeps,
} from '../application/dispatcher'

export type { IntentDispatchDeps }

// RFC-503: no empty-list guard here — application's resume treats an empty list as a no-op (no listing, no loop, no events).
export async function resumeQueuedIntentWorkingSets(
  dependencies: IntentDispatchDeps,
  sessionIds: readonly string[],
): Promise<void> {
  await resumeWorkingSets(dependencies, sessionIds)
}
