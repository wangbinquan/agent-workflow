import type { AclResourceType, ResourceAccess, ResourceGrantLevel } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  discloseRefsSync,
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  isVisibleRow,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
  type DisclosedRefs,
} from '../domain/resourceAccess'
import type { ResourceCatalogGrantReadPort } from './ports/providerResourceCatalogPersistence'

/**
 * Provider-bound authorization application used by PostgreSQL and by the
 * provider-neutral bootstrap successor.  It preserves the exact access ladder
 * while keeping every database/transaction handle behind the grant port.
 */
export function createResourceAuthorizationApplication(grants: ResourceCatalogGrantReadPort) {
  async function discloseRefs(
    actor: Actor,
    type: AclResourceType,
    rows: ReadonlyArray<AclRow & { readonly name: string }>,
  ): Promise<DisclosedRefs> {
    const granted =
      hasResourceAclBypass(actor) || !hasPrivateResourceAccess(actor)
        ? new Set<string>()
        : await grants.listGrantedResourceIds(actor, type)
    return discloseRefsSync(actor, rows, granted)
  }

  async function filterVisibleRows<T extends AclRow>(
    actor: Actor,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<T[]> {
    if (hasResourceAclBypass(actor)) return [...rows]
    if (!hasPrivateResourceAccess(actor)) {
      return rows.filter((row) => (row.visibility ?? 'public') === 'public')
    }
    const granted = await grants.listGrantedResourceIds(actor, type)
    return rows.filter((row) => isVisibleRow(actor, row, granted))
  }

  async function projectVisibleRowsWithAccess<T extends AclRow>(
    actor: Actor,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<Array<T & { readonly access: ResourceAccess }>> {
    const authority = resourceAclAudienceAuthority(actor)
    const levels =
      authority.bypass || !authority.private || rows.length === 0
        ? new Map<string, ResourceGrantLevel>()
        : await grants.loadGrantLevelsForUser(
            type,
            rows.map((row) => row.id),
            actor.user.id,
          )
    return rows.flatMap((row) => {
      const access = resolveAccessFrom(authority, actor.user.id, row, levels.get(row.id) ?? null)
      return access === 'none' ? [] : [{ ...row, access }]
    })
  }

  async function resolveResourceAccessFor(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<ResourceAccess> {
    const authority = resourceAclAudienceAuthority(actor)
    const level =
      authority.bypass || !authority.private
        ? null
        : await grants.loadGrantLevel(type, row.id, actor.user.id)
    return resolveAccessFrom(authority, actor.user.id, row, level)
  }

  async function canViewResource(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<boolean> {
    return canViewAccess(await resolveResourceAccessFor(actor, type, row))
  }

  async function canEditResource(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<boolean> {
    return canEditAccess(await resolveResourceAccessFor(actor, type, row))
  }

  function canGovernResource(actor: Actor, row: AclRow): boolean {
    return canGovernAccess(resolveResourceAccess(actor, row, null))
  }

  async function requireResourceView(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<void> {
    if (await canViewResource(actor, type, row)) return
    throw new NotFoundError('not-found', `${type} not found`)
  }

  async function requireResourceGovern(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<void> {
    await requireResourceView(actor, type, row)
    if (canGovernResource(actor, row)) return
    throw new ForbiddenError(
      'resource-govern-owner-only',
      `deleting, renaming, transferring or re-granting a ${type} is reserved for its owner`,
    )
  }

  async function requireResourceEdit(
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<ResourceAccess> {
    const access = await resolveResourceAccessFor(actor, type, row)
    if (!canViewAccess(access)) throw new NotFoundError('not-found', `${type} not found`)
    if (canEditAccess(access)) return access
    throw new ForbiddenError(
      'resource-read-only',
      `you have read-only access to this ${type}; ask its owner for an edit grant or make your own copy`,
    )
  }

  return Object.freeze({
    canEditResource,
    canGovernResource,
    canViewResource,
    discloseRefs,
    filterVisibleRows,
    projectVisibleRowsWithAccess,
    requireResourceEdit,
    requireResourceGovern,
    requireResourceView,
    resolveResourceAccessFor,
  })
}

export type ResourceAuthorizationApplication = ReturnType<
  typeof createResourceAuthorizationApplication
>
