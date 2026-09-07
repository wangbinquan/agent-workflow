// RFC-359: receive a complete policy in the constructor. Bootstrap callbacks
// may reference later lexical bindings; there is no empty slot or second bind
// step that one provider could forget. Snapshot methods with their original
// receivers so each daemon retains its own complete policy.

import type { RealtimeCompositionPolicy } from '@/modules/runtime-management/public/participants'

export function composeDaemonRealtimePolicy(
  policy: RealtimeCompositionPolicy,
): RealtimeCompositionPolicy {
  const canViewResource = policy.resourceVisibility.canViewResource.bind(policy.resourceVisibility)
  const canViewMemory = policy.memoryVisibility.canViewMemory.bind(policy.memoryVisibility)
  const repoImportOwnerUserId = policy.repoImportOwnerUserId.bind(policy)
  const redactTaskEventPayload = policy.redactTaskEventPayload.bind(policy)

  return Object.freeze({
    resourceVisibility: Object.freeze({ canViewResource }),
    memoryVisibility: Object.freeze({ canViewMemory }),
    repoImportOwnerUserId,
    redactTaskEventPayload,
  })
}
