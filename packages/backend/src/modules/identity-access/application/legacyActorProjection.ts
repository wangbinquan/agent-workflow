import {
  resolveEffectiveAccountPermissions,
  resolveTokenPermissions,
  type PatPurpose,
  type Permission,
} from '@agent-workflow/shared'
import type { AuthenticatedAuthoritySnapshot, LegacyActorProjection } from '../public/participants'
import type { ResolvedAuthoritySubject } from '../public/types'

const SYSTEM_USER_ID = '__system__'

export type DirectLegacyProjectionInput = Readonly<{
  source: 'session' | 'pat' | 'daemon'
  patScopes?: ReadonlyArray<Permission>
  patPurpose?: PatPurpose
  patId?: string
}>

/** Unbranded account projection prepared for the registry-owned direct
 * authority factory. It is not a usable authority until that factory freezes,
 * brands and registers it with the matching request handle. */
export interface DirectLegacyProjection extends AuthenticatedAuthoritySnapshot {
  readonly userId: string
}

/**
 * RFC-347's single compatibility projection.  Both direct and delegated
 * authority paths call this function with facts already resolved by the
 * identity-access runtime; it performs no I/O and has no mint input of its own.
 */
export function projectDirectLegacyActor(
  subject: ResolvedAuthoritySubject,
  input: DirectLegacyProjectionInput,
): DirectLegacyProjection {
  const accountPermissions = resolveEffectiveAccountPermissions({
    role: subject.role,
    additionalPermissions: subject.additionalPermissions,
  })
  const permissions =
    input.source === 'pat'
      ? resolveTokenPermissions({
          accountPermissions,
          matrix: input.patScopes ?? [],
        })
      : accountPermissions
  return {
    user: Object.freeze({
      id: subject.userId,
      username: subject.username,
      displayName: subject.displayName,
      role: subject.role,
      status: subject.status,
    }),
    userId: subject.userId,
    source: input.source,
    permissions,
    ...(input.source === 'pat'
      ? {
          purpose: input.patPurpose ?? ('mcp_only' as const),
          ...(input.patId === undefined ? {} : { patId: input.patId }),
        }
      : {}),
    authorityRevision: subject.accessRevision,
  }
}

export function projectDelegatedLegacyActor(
  subject: ResolvedAuthoritySubject,
): LegacyActorProjection {
  return Object.freeze({
    user: Object.freeze({
      id: subject.userId,
      username: subject.username,
      displayName: subject.displayName,
      role: subject.role,
      status: subject.status,
    }),
    userId: subject.userId,
    source: 'daemon' as const,
    permissions: resolveEffectiveAccountPermissions({
      role: subject.role,
      additionalPermissions: subject.additionalPermissions,
    }),
    authorityRevision: subject.accessRevision,
  }) as unknown as LegacyActorProjection
}

/** RFC-285 Q5 test oracle. Production task-execution owns its local NULL-owner
 * compatibility value and does not import this module across the boundary. */
export function projectOwnerlessLegacyActor(): LegacyActorProjection {
  return Object.freeze({
    user: Object.freeze({
      id: SYSTEM_USER_ID,
      username: SYSTEM_USER_ID,
      displayName: SYSTEM_USER_ID,
      role: 'user' as const,
      status: 'active' as const,
    }),
    userId: SYSTEM_USER_ID,
    source: 'daemon' as const,
    permissions: new Set<Permission>(),
    authorityRevision: 0,
  }) as unknown as LegacyActorProjection
}
