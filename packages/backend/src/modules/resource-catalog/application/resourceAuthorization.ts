import type { AclResourceType, ResourceAccess, ResourceGrantLevel } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
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
import type { ResourceGrantReadPort } from './ports/resourceAclPersistence'

export function createResourceAuthorizationApplication(grants: ResourceGrantReadPort) {
  async function discloseRefs(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    rows: ReadonlyArray<AclRow & { readonly name: string }>,
  ): Promise<DisclosedRefs> {
    const granted =
      hasResourceAclBypass(actor) || !hasPrivateResourceAccess(actor)
        ? new Set<string>()
        : await grants.listGrantedResourceIds(db, actor, type)
    return discloseRefsSync(actor, rows, granted)
  }

  async function filterVisibleRows<T extends AclRow>(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<T[]> {
    if (hasResourceAclBypass(actor)) return [...rows]
    if (!hasPrivateResourceAccess(actor)) {
      return rows.filter((row) => (row.visibility ?? 'public') === 'public')
    }
    const granted = await grants.listGrantedResourceIds(db, actor, type)
    return rows.filter((row) => isVisibleRow(actor, row, granted))
  }

  async function projectVisibleRowsWithAccess<T extends AclRow>(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<Array<T & { readonly access: ResourceAccess }>> {
    const authority = resourceAclAudienceAuthority(actor)
    const grantLevels =
      authority.bypass || !authority.private || rows.length === 0
        ? new Map<string, ResourceGrantLevel>()
        : await grants.loadGrantLevelsForUser(
            db,
            type,
            rows.map((row) => row.id),
            actor.user.id,
          )
    const out: Array<T & { readonly access: ResourceAccess }> = []
    for (const row of rows) {
      const access = resolveAccessFrom(
        authority,
        actor.user.id,
        row,
        grantLevels.get(row.id) ?? null,
      )
      if (access !== 'none') out.push({ ...row, access })
    }
    return out
  }

  async function resolveResourceAccessFor(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<ResourceAccess> {
    const authority = resourceAclAudienceAuthority(actor)
    if (authority.bypass || !authority.private) {
      return resolveAccessFrom(authority, actor.user.id, row, null)
    }
    return resolveAccessFrom(
      authority,
      actor.user.id,
      row,
      await grants.loadGrantLevel(db, type, row.id, actor.user.id),
    )
  }

  function resolveResourceAccessForInTx(
    tx: DbTxSync,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): ResourceAccess {
    const authority = resourceAclAudienceAuthority(actor)
    if (authority.bypass || !authority.private) {
      return resolveAccessFrom(authority, actor.user.id, row, null)
    }
    return resolveAccessFrom(
      authority,
      actor.user.id,
      row,
      grants.loadGrantLevelInTx(tx, type, row.id, actor.user.id),
    )
  }

  async function canViewResource(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<boolean> {
    return canViewAccess(await resolveResourceAccessFor(db, actor, type, row))
  }

  function canViewResourceInTx(
    tx: DbTxSync,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): boolean {
    return canViewAccess(resolveResourceAccessForInTx(tx, actor, type, row))
  }

  async function canEditResource(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<boolean> {
    return canEditAccess(await resolveResourceAccessFor(db, actor, type, row))
  }

  function canEditResourceInTx(
    tx: DbTxSync,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): boolean {
    return canEditAccess(resolveResourceAccessForInTx(tx, actor, type, row))
  }

  async function requireResourceView(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<void> {
    if (await canViewResource(db, actor, type, row)) return
    throw new NotFoundError('not-found', `${type} not found`)
  }

  function canGovernResource(actor: Actor, row: AclRow): boolean {
    return canGovernAccess(resolveResourceAccess(actor, row, null))
  }

  async function requireResourceGovern(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<void> {
    await requireResourceView(db, actor, type, row)
    if (canGovernResource(actor, row)) return
    throw new ForbiddenError(
      'resource-govern-owner-only',
      `deleting, renaming, transferring or re-granting a ${type} is reserved for its owner`,
    )
  }

  async function requireResourceEdit(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ): Promise<ResourceAccess> {
    const access = await resolveResourceAccessFor(db, actor, type, row)
    if (!canViewAccess(access)) throw new NotFoundError('not-found', `${type} not found`)
    if (canEditAccess(access)) return access
    throw new ForbiddenError(
      'resource-read-only',
      `you have read-only access to this ${type}; ask its owner for an edit grant or make your own copy`,
    )
  }

  return {
    canEditResource,
    canEditResourceInTx,
    canGovernResource,
    canViewResource,
    canViewResourceInTx,
    discloseRefs,
    filterVisibleRows,
    projectVisibleRowsWithAccess,
    requireResourceEdit,
    requireResourceGovern,
    requireResourceView,
    resolveResourceAccessFor,
    resolveResourceAccessForInTx,
  }
}

export type ResourceAuthorizationApplication = ReturnType<
  typeof createResourceAuthorizationApplication
>
