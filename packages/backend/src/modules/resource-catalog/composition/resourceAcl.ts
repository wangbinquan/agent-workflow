import type {
  AclResourceType,
  ResourceAccess,
  ResourceAcl,
  ResourceVisibility,
  UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { DbTxSync } from '@/db/txSync'
import { assertNotBuiltin } from '@/services/systemResources'
import { triggerRevalidation } from '@/ws/revalidationHook'
import {
  createResourceAclApplication,
  createResourceAclOperationApplication,
  type ResourceAclApplication,
  type ResourceAclOperationLinearizer,
} from '../application/resourceAcl'
import type {
  ResourceAclIdentityPersistence,
  SyncResourceAclIdentityPersistence,
} from '../application/ports/resourceAclPersistence'
import type { ResourceCatalogOwnedAclType } from '../application/ports/providerResourceCatalogPersistence'
import { createResourceAuthorizationApplication } from '../application/resourceAuthorization'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
  type DisclosedRefs,
} from '../domain/resourceAccess'
import { createResourceAclReadPort } from '../infrastructure/aclReadRepository'
import { createResourceGrantReadPort } from '../infrastructure/resourceVisibility'
import { createResourceAclMutationPort } from '../infrastructure/resourceAclRepository'
import {
  createSqliteResourceAclMutationPort,
  createSqliteResourceAclReadPort,
  type SqliteResourceAclMutationLifecycle,
} from '../infrastructure/sqliteResourceAclRepository'
import {
  createSqliteResourceGrantReadPort,
  loadGrantLevelInTx,
} from '../infrastructure/sqliteResourceGrantRepository'

function buildSqliteAclApplications(input: {
  readonly db: DbClient
  readonly identityPersistence?: SyncResourceAclIdentityPersistence
  readonly lifecycle?: SqliteResourceAclMutationLifecycle
}) {
  const authorization = createResourceAuthorizationApplication(
    createSqliteResourceGrantReadPort(input.db),
  )
  // RFC-359 W4-D3：目录自有类型走中立的读 / 写端口（统一事务原语）；带 owner 侧同步 identity persistence /
  // 同步 after-write 钩子的调用（development_adapter / employee_* / mcp 装配）仍走 SQLite 同步路径，随各 owner 的 dbTxSync 归零一起退。
  const legacy = input.identityPersistence !== undefined || input.lifecycle !== undefined
  return Object.freeze({
    authorization,
    acl: createResourceAclApplication<AclResourceType>({
      authorization,
      mutation: legacy
        ? createSqliteResourceAclMutationPort(input.db, input.lifecycle, input.identityPersistence)
        : createResourceAclMutationPort(input.db),
      read: legacy
        ? createSqliteResourceAclReadPort(input.db, input.identityPersistence)
        : createResourceAclReadPort(input.db),
    }),
  })
}

type SqliteAclApplications = ReturnType<typeof buildSqliteAclApplications>
const sqliteAclApplications = new WeakMap<DbClient, SqliteAclApplications>()

function applicationsFor(
  db: DbClient,
  input: {
    readonly identityPersistence?: SyncResourceAclIdentityPersistence
    readonly lifecycle?: SqliteResourceAclMutationLifecycle
  } = {},
): SqliteAclApplications {
  if (input.identityPersistence !== undefined || input.lifecycle !== undefined) {
    return buildSqliteAclApplications({ db, ...input })
  }
  const current = sqliteAclApplications.get(db)
  if (current !== undefined) return current
  const created = buildSqliteAclApplications({ db })
  sqliteAclApplications.set(db, created)
  return created
}

export function discloseRefs(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: ReadonlyArray<AclRow & { readonly name: string }>,
): Promise<DisclosedRefs> {
  return applicationsFor(db).authorization.discloseRefs(actor, type, rows)
}

export function filterVisibleRows<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  return applicationsFor(db).authorization.filterVisibleRows(actor, type, rows)
}

export function projectVisibleRowsWithAccess<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<Array<T & { readonly access: ResourceAccess }>> {
  return applicationsFor(db).authorization.projectVisibleRowsWithAccess(actor, type, rows)
}

export function resolveResourceAccessFor(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAccess> {
  return applicationsFor(db).authorization.resolveResourceAccessFor(actor, type, row)
}

export function resolveResourceAccessForInTx(
  tx: DbTxSync,
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
      : loadGrantLevelInTx(tx, type, row.id, actor.user.id),
  )
}

export function canViewResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  return applicationsFor(db).authorization.canViewResource(actor, type, row)
}

export function canViewResourceInTx(
  tx: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): boolean {
  return canViewAccess(resolveResourceAccessForInTx(tx, actor, type, row))
}

export function canEditResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  return applicationsFor(db).authorization.canEditResource(actor, type, row)
}

export function canEditResourceInTx(
  tx: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): boolean {
  return canEditAccess(resolveResourceAccessForInTx(tx, actor, type, row))
}

export function canGovernResource(actor: Actor, row: AclRow): boolean {
  return canGovernAccess(resolveResourceAccess(actor, row, null))
}

export function requireResourceView(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  return applicationsFor(db).authorization.requireResourceView(actor, type, row)
}

export function requireResourceGovern(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  return applicationsFor(db).authorization.requireResourceGovern(actor, type, row)
}

export function requireResourceEdit(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAccess> {
  return applicationsFor(db).authorization.requireResourceEdit(actor, type, row)
}

export function getResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  identityPersistence?: SyncResourceAclIdentityPersistence,
): Promise<ResourceAcl> {
  return applicationsFor(db, { identityPersistence }).acl.getResourceAcl(actor, type, row)
}

export interface ResourceAclWriteEffects {
  readonly identityPersistence?: SyncResourceAclIdentityPersistence
  readonly afterWriteInTx?: (
    tx: DbTxSync,
    change: {
      readonly resourceId: string
      readonly ownerUserId: string | null
      readonly visibility: ResourceVisibility
      readonly grantedUserIds: ReadonlySet<string>
      readonly now: number
    },
  ) => void
  readonly afterCommit?: (db: DbClient) => void
  readonly updatedAt?: number
}

export function updateResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  body: UpdateResourceAclBody,
  options: ResourceAclWriteEffects = {},
): Promise<ResourceAcl> {
  const lifecycle: SqliteResourceAclMutationLifecycle | undefined =
    options.afterWriteInTx === undefined
      ? undefined
      : {
          afterWriteInTransaction: (tx, change) =>
            options.afterWriteInTx?.(tx, {
              resourceId: change.resourceId,
              ownerUserId: change.ownerUserId,
              visibility: change.visibility,
              grantedUserIds: change.grantedUserIds,
              now: change.now,
            }),
        }
  return applicationsFor(db, {
    identityPersistence: options.identityPersistence,
    lifecycle,
  }).acl.updateResourceAcl(actor, type, row, body, {
    updatedAt: options.updatedAt,
    afterCommit: async () => {
      await options.afterCommit?.(db)
      // Every ACL write wakes live sockets from HERE, not from each mount.
      // The retired `services/resourceAcl` facade attached this, so when the
      // digital-employee / development-config / capability-template mounts were
      // cut over to call this composition directly they silently stopped
      // notifying: a downgraded or upgraded viewer kept the old controls until
      // they happened to reload, which they have no reason to do.
      triggerRevalidation('resource-acl-changed')
    },
  })
}

export interface ResourceAclOperationCompositionDependencies<Row extends AclRow> {
  readonly db: DbClient
  readonly type: AclResourceType
  load(id: string): Promise<Row | null>
  readonly linearizer?: ResourceAclOperationLinearizer<Row>
  readonly afterWriteInTx?: ResourceAclWriteEffects['afterWriteInTx']
  afterUpdated?(resourceId: string): void | Promise<void>
}

export interface ProviderResourceAclOperationCompositionDependencies<
  Type extends ResourceCatalogOwnedAclType,
  Row extends AclRow,
> {
  readonly authorization: ResourceAuthorizationApplication
  readonly acl: ResourceAclApplication
  readonly type: Type
  load(id: string): Promise<Row | null>
  readonly linearizer?: ResourceAclOperationLinearizer<Row>
  afterUpdated?(resourceId: string): void | Promise<void>
}

/**
 * Provider-neutral classic aggregate ACL composition. PostgreSQL and future
 * providers reuse the same authorization/ACL applications; no bootstrap code
 * receives a database handle or reconstructs the access ladder.
 */
export function composeProviderResourceAclOperationApplication<
  Context extends Actor,
  Type extends ResourceCatalogOwnedAclType,
  Row extends AclRow,
>(input: ProviderResourceAclOperationCompositionDependencies<Type, Row>) {
  return createResourceAclOperationApplication<Context, Row>({
    type: input.type,
    load: input.load,
    canView: (authority, row) => input.authorization.canViewResource(authority, input.type, row),
    assertMutable: (row) => assertNotBuiltin(input.type, row),
    read: (authority, row) => input.acl.getResourceAcl(authority, input.type, row),
    update: (authority, row, body, updatedAt) =>
      input.acl.updateResourceAcl(authority, input.type, row, body, { updatedAt }),
    linearizer: input.linearizer,
    afterUpdated: input.afterUpdated,
  })
}

/** Owner composition for the classic-six descriptor-backed ACL operations. */
export function composeResourceAclOperationApplication<Context extends Actor, Row extends AclRow>(
  input: ResourceAclOperationCompositionDependencies<Row>,
) {
  return createResourceAclOperationApplication<Context, Row>({
    type: input.type,
    load: input.load,
    canView: (authority, row) => canViewResource(input.db, authority, input.type, row),
    assertMutable: (row) => assertNotBuiltin(input.type, row),
    read: (authority, row) => getResourceAcl(input.db, authority, input.type, row),
    update: (authority, row, body, updatedAt): Promise<ResourceAcl> =>
      updateResourceAcl(input.db, authority, input.type, row, body, {
        updatedAt,
        afterWriteInTx: input.afterWriteInTx,
      }),
    linearizer: input.linearizer,
    afterUpdated: input.afterUpdated,
  })
}

/**
 * RFC-359 W4-D6 —— owner 在别的 context 的 ACL 行（development_adapter / employee_*）：目录只出决策、grants 与
 * users，identity 行经 owner 交来的 `ResourceAclIdentityPersistence` 在同一个目录写事务里读 / 写。两个 provider 同一份；
 * 每次写完在提交后唤醒实时订阅（与目录自有类型的 `updateResourceAcl` 同一处）。
 */
export function composeForeignResourceAclFor(input: {
  readonly db: ProviderNeutralDatabase
  readonly identity: ResourceAclIdentityPersistence
}) {
  const authorization = createResourceAuthorizationApplication(
    createResourceGrantReadPort(input.db),
  )
  const acl = createResourceAclApplication<AclResourceType>({
    authorization,
    mutation: createResourceAclMutationPort(input.db, {}, input.identity),
    read: createResourceAclReadPort(input.db, input.identity),
  })
  return Object.freeze({
    authorization,
    // 看不见即不存在：与此前 PG foreign 路径的 read 同语义（路由层的 canView 门之外再守一次，无 UI 差异）。
    getResourceAcl: async (actor: Actor, type: AclResourceType, row: AclRow) => {
      await authorization.requireResourceView(actor, type, row)
      return await acl.getResourceAcl(actor, type, row)
    },
    updateResourceAcl: (
      actor: Actor,
      type: AclResourceType,
      row: AclRow,
      body: UpdateResourceAclBody,
      options: { readonly updatedAt?: number } = {},
    ) =>
      acl.updateResourceAcl(actor, type, row, body, {
        ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        afterCommit: async () => {
          triggerRevalidation('resource-acl-changed')
        },
      }),
  })
}
