// RFC-349 bootstrap convergence -- realtime depends on provider-owned stores,
// but its channel policy is assembled from Resource Catalog, Memory and
// transport owners after the provider core exists. This request-local binding
// lets the core retain one stable policy reference without an ambient registry
// or an optional fallback.

import type { RealtimeCompositionPolicy } from '@/modules/runtime-management/public/participants'

export interface DaemonRealtimePolicyBinding {
  readonly policy: RealtimeCompositionPolicy
  bind(policy: RealtimeCompositionPolicy): void
}

function snapshotPolicy(policy: RealtimeCompositionPolicy): RealtimeCompositionPolicy {
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

/**
 * Creates one daemon-session-local policy reference. Provider composition may
 * retain `policy` immediately, but every operation fails closed until bootstrap
 * binds the complete real policy exactly once and before admission opens.
 */
export function createDaemonRealtimePolicyBinding(): DaemonRealtimePolicyBinding {
  let boundPolicy: RealtimeCompositionPolicy | undefined

  function requireBoundPolicy(): RealtimeCompositionPolicy {
    if (boundPolicy === undefined) throw new Error('daemon-realtime-policy-not-bound')
    return boundPolicy
  }

  const policy: RealtimeCompositionPolicy = Object.freeze({
    resourceVisibility: Object.freeze({
      async canViewResource(
        actor: Parameters<RealtimeCompositionPolicy['resourceVisibility']['canViewResource']>[0],
        type: Parameters<RealtimeCompositionPolicy['resourceVisibility']['canViewResource']>[1],
        row: Parameters<RealtimeCompositionPolicy['resourceVisibility']['canViewResource']>[2],
      ) {
        return await requireBoundPolicy().resourceVisibility.canViewResource(actor, type, row)
      },
    }),
    memoryVisibility: Object.freeze({
      async canViewMemory(
        authority: Parameters<RealtimeCompositionPolicy['memoryVisibility']['canViewMemory']>[0],
        actor: Parameters<RealtimeCompositionPolicy['memoryVisibility']['canViewMemory']>[1],
        scope: Parameters<RealtimeCompositionPolicy['memoryVisibility']['canViewMemory']>[2],
      ) {
        return await requireBoundPolicy().memoryVisibility.canViewMemory(authority, actor, scope)
      },
    }),
    repoImportOwnerUserId(
      batchId: Parameters<RealtimeCompositionPolicy['repoImportOwnerUserId']>[0],
    ) {
      return requireBoundPolicy().repoImportOwnerUserId(batchId)
    },
    redactTaskEventPayload(
      payload: Parameters<RealtimeCompositionPolicy['redactTaskEventPayload']>[0],
      actorSource: Parameters<RealtimeCompositionPolicy['redactTaskEventPayload']>[1],
    ) {
      return requireBoundPolicy().redactTaskEventPayload(payload, actorSource)
    },
  })

  return Object.freeze({
    policy,
    bind(nextPolicy: RealtimeCompositionPolicy) {
      if (boundPolicy !== undefined) throw new Error('daemon-realtime-policy-already-bound')
      boundPolicy = snapshotPolicy(nextPolicy)
    },
  })
}
