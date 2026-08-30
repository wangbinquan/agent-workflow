// RFC-345 T2 — resource access policy owned by the resource-catalog domain.
// The input is a neutral authority projection, never auth/Actor, DB or Drizzle.

import type {
  Permission,
  ResourceAccess,
  ResourceGrantLevel,
  ResourceVisibility,
} from '@agent-workflow/shared'

export interface AclRow {
  readonly id: string
  readonly ownerUserId?: string | null
  readonly visibility?: ResourceVisibility
  readonly builtin?: boolean | null
}

/** The exact identity/access face consumed by resource ACL policy. */
export interface ResourceAclActorProjection {
  readonly user: Readonly<{ readonly id: string }>
  readonly permissions: ReadonlySet<Permission>
}

export interface ResourceAclAudienceAuthority {
  readonly bypass: boolean
  readonly private: boolean
}

export function hasResourceAclBypass(actor: ResourceAclActorProjection): boolean {
  return actor.permissions.has('resource-acl:bypass')
}

export function hasPrivateResourceAccess(actor: ResourceAclActorProjection): boolean {
  return actor.permissions.has('resource-acl:private')
}

export function resourceAclAudienceAuthority(
  actor: ResourceAclActorProjection,
): ResourceAclAudienceAuthority {
  return {
    bypass: hasResourceAclBypass(actor),
    private: hasPrivateResourceAccess(actor),
  }
}

/** The single `own > write > read > none` ladder. */
export function resolveAccessFrom(
  authority: ResourceAclAudienceAuthority,
  userId: string,
  row: Pick<AclRow, 'ownerUserId' | 'visibility'>,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  if (authority.bypass) return 'own'
  const isPublic = (row.visibility ?? 'public') === 'public'
  const ownerMatch = row.ownerUserId != null && row.ownerUserId === userId
  if (ownerMatch && (isPublic || authority.private)) return 'own'
  if (!authority.private) return isPublic ? 'read' : 'none'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return isPublic ? 'read' : 'none'
}

export function resolveResourceAccess(
  actor: ResourceAclActorProjection,
  row: AclRow,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  return resolveAccessFrom(resourceAclAudienceAuthority(actor), actor.user.id, row, grant)
}

export function canViewAccess(access: ResourceAccess): boolean {
  return access !== 'none'
}

export function canEditAccess(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

export function canGovernAccess(access: ResourceAccess): boolean {
  return access === 'own'
}

export function canEditRow(
  actor: ResourceAclActorProjection,
  row: AclRow,
  writableGrantIds: ReadonlySet<string>,
): boolean {
  return canEditAccess(
    resolveResourceAccess(actor, row, writableGrantIds.has(row.id) ? 'write' : null),
  )
}

/** Visibility against a pre-fetched audience snapshot. */
export function isVisibleToAudienceSnapshot(
  userId: string,
  authority: ResourceAclAudienceAuthority,
  snapshot: {
    readonly visibility: 'public' | 'private'
    readonly ownerUserId: string | null
    readonly grantedUserIds: ReadonlySet<string>
  },
): boolean {
  return canViewAccess(
    resolveAccessFrom(
      authority,
      userId,
      snapshot,
      snapshot.grantedUserIds.has(userId) ? 'read' : null,
    ),
  )
}

/** Visibility against an already-prefetched grant-id set. */
export function isVisibleRow(
  actor: ResourceAclActorProjection,
  row: AclRow,
  grantedIds: ReadonlySet<string>,
): boolean {
  return canViewAccess(resolveResourceAccess(actor, row, grantedIds.has(row.id) ? 'read' : null))
}

export interface DisclosedRefs {
  readonly visible: Array<{ readonly id: string; readonly name: string }>
  readonly hiddenCount: number
}

export function discloseRefsSync(
  actor: ResourceAclActorProjection,
  rows: ReadonlyArray<AclRow & { readonly name: string }>,
  grantedIds: ReadonlySet<string>,
): DisclosedRefs {
  const visible = rows.filter((row) => isVisibleRow(actor, row, grantedIds))
  return {
    visible: visible.map((row) => ({ id: row.id, name: row.name })),
    hiddenCount: rows.length - visible.length,
  }
}

/** Scheduled tasks have member visibility rather than an ACL resource row. */
export function discloseScheduleRefs(
  actor: ResourceAclActorProjection,
  rows: ReadonlyArray<{ readonly id: string; readonly name: string; readonly ownerUserId: string }>,
): DisclosedRefs {
  const canSeeAll = actor.permissions.has('tasks:read:all')
  const visible = rows.filter((row) => canSeeAll || row.ownerUserId === actor.user.id)
  return {
    visible: visible.map((row) => ({ id: row.id, name: row.name })),
    hiddenCount: rows.length - visible.length,
  }
}

/** Pure rule behind the owner-only rename assertion. */
export function isResourceNameSubmissionAllowed(
  access: ResourceAccess,
  currentName: string,
  submittedName: string | null | undefined,
): boolean {
  return (
    canGovernAccess(access) ||
    submittedName === null ||
    submittedName === undefined ||
    submittedName === currentName
  )
}
