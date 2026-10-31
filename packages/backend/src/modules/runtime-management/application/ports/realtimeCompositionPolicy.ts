// RFC-400: bootstrap-owned realtime policy is an internal assembly input.
import type {
  AuthenticatedAuthoritySnapshot,
  DirectRequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { RealtimeAclResourceType, RealtimeMemoryScope } from './realtimeStore'

/** Closed resource projection shared by provider stores and visibility policy. */
interface RealtimeResourceProjection {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

interface RealtimeResourceVisibility {
  canViewResource(
    actor: AuthenticatedAuthoritySnapshot,
    type: RealtimeAclResourceType,
    resource: RealtimeResourceProjection,
  ): Promise<boolean>
}

interface RealtimeMemoryVisibility {
  canViewMemory(
    authority: DirectRequestAuthority,
    actor: AuthenticatedAuthoritySnapshot,
    scope: RealtimeMemoryScope,
  ): Promise<boolean>
}

/** Cross-owner policy consumed by runtime-management provider composition. */
export interface RealtimeCompositionPolicy {
  readonly resourceVisibility: RealtimeResourceVisibility
  readonly memoryVisibility: RealtimeMemoryVisibility
  readonly repoImportOwnerUserId: (batchId: string) => string | null
  readonly redactTaskEventPayload: (
    payload: unknown,
    actorSource: AuthenticatedAuthoritySnapshot['source'],
  ) => unknown
}
