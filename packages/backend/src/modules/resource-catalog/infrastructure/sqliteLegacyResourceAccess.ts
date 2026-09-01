import type { AclResourceType, ResourceAccess } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { createResourceAuthorizationApplication } from '../application/resourceAuthorization'
import {
  canEditAccess,
  canViewAccess,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
  type AclRow,
  type DisclosedRefs,
} from '../domain/resourceAccess'
import {
  createSqliteResourceGrantReadPort,
  loadGrantLevelInTx,
} from './sqliteResourceGrantRepository'

/**
 * Provider-private compatibility reads for the remaining SQLite lifecycle
 * adapters. New HTTP/CLI consumers use the provider-neutral catalog
 * applications; these helpers keep an already-owned SQLite transaction on the
 * same ACL ladder without routing through the retired services/resourceAcl
 * facade.
 */
function authorizationFor(db: DbClient) {
  return createResourceAuthorizationApplication(createSqliteResourceGrantReadPort(db))
}

export function discloseSqliteResourceRefs(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: ReadonlyArray<AclRow & { readonly name: string }>,
): Promise<DisclosedRefs> {
  return authorizationFor(db).discloseRefs(actor, type, rows)
}

export function filterVisibleSqliteResourceRows<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  return authorizationFor(db).filterVisibleRows(actor, type, rows)
}

export function resolveSqliteResourceAccess(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAccess> {
  return authorizationFor(db).resolveResourceAccessFor(actor, type, row)
}

export function resolveSqliteResourceAccessInTransaction(
  transaction: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): ResourceAccess {
  const authority = resourceAclAudienceAuthority(actor)
  return resolveAccessFrom(
    authority,
    actor.user.id,
    row,
    authority.bypass || !authority.private
      ? null
      : loadGrantLevelInTx(transaction, type, row.id, actor.user.id),
  )
}

export function canViewSqliteResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  return authorizationFor(db).canViewResource(actor, type, row)
}

export function canViewSqliteResourceInTransaction(
  transaction: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): boolean {
  return canViewAccess(resolveSqliteResourceAccessInTransaction(transaction, actor, type, row))
}

export function canEditSqliteResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  return authorizationFor(db).canEditResource(actor, type, row)
}

export function canEditSqliteResourceInTransaction(
  transaction: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): boolean {
  return canEditAccess(resolveSqliteResourceAccessInTransaction(transaction, actor, type, row))
}
