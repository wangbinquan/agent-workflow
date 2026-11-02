// RFC-417: hosted (CrewStation) platform capability evidence, moved verbatim from composition/crewstationExecution.ts:
// one cached read per window serves every compile, and a profile's capability counts only at version 1.
import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'

const CAPABILITY_CACHE_MS = 30_000

/** Platform capability evidence changes only when a profile is re-tested;
 * one cached read serves every compile in that window. */
export function createCachedHostedCapabilities(
  read: () => Promise<HostedRuntimeCapabilities>,
  now: () => number = Date.now,
): () => Promise<HostedRuntimeCapabilities> {
  let value: HostedRuntimeCapabilities | undefined
  let readAt = 0
  let pending: Promise<HostedRuntimeCapabilities> | undefined
  return async () => {
    if (value !== undefined && now() - readAt < CAPABILITY_CACHE_MS) return value
    pending ??= read()
      .then((fresh) => {
        value = fresh
        readAt = now()
        return fresh
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

export type HostedProfileCapabilityName =
  | 'startupInventoryVersion'
  | 'nativeConfigVersion'
  | 'nativeModelMappingVersion'
  | 'materialObjectsVersion'

/** Whether the selected Agent profile reports the named capability (version 1). */
export function hostedProfileCapability(capabilities: () => Promise<HostedRuntimeCapabilities>) {
  return (name: HostedProfileCapabilityName) => async (agentProfileId: string) =>
    (await capabilities()).agentProfiles.some(
      (profile) => profile.agentProfileId === agentProfileId && profile.capabilities[name] === 1,
    )
}
