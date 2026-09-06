import type {
  AclResourceType,
  ResourceAccess,
  ResourceAcl,
  UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
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
import type { ResourceAclIdentityPersistence } from '../application/ports/resourceAclPersistence'
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
import { loadGrantLevelInTx } from '../infrastructure/sqliteResourceGrantRepository'

function buildAclApplications(db: ProviderNeutralDatabase): AclApplications {
  const authorization = createResourceAuthorizationApplication(createResourceGrantReadPort(db))
  return Object.freeze({
    authorization,
    acl: createResourceAclApplication<AclResourceType>({
      authorization,
      mutation: createResourceAclMutationPort(db),
      read: createResourceAclReadPort(db),
    }),
  })
}

interface AclApplications {
  readonly authorization: ResourceAuthorizationApplication
  readonly acl: ReturnType<typeof createResourceAclApplication<AclResourceType>>
}

const aclApplications = new WeakMap<ProviderNeutralDatabase, AclApplications>()

function applicationsFor(db: ProviderNeutralDatabase): AclApplications {
  const current = aclApplications.get(db)
  if (current !== undefined) return current
  const created = buildAclApplications(db)
  aclApplications.set(db, created)
  return created
}

export function discloseRefs(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  rows: ReadonlyArray<AclRow & { readonly name: string }>,
): Promise<DisclosedRefs> {
  return applicationsFor(db).authorization.discloseRefs(actor, type, rows)
}

export function filterVisibleRows<T extends AclRow>(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  return applicationsFor(db).authorization.filterVisibleRows(actor, type, rows)
}

export function projectVisibleRowsWithAccess<T extends AclRow>(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<Array<T & { readonly access: ResourceAccess }>> {
  return applicationsFor(db).authorization.projectVisibleRowsWithAccess(actor, type, rows)
}

export function resolveResourceAccessFor(
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  return applicationsFor(db).authorization.requireResourceView(actor, type, row)
}

export function requireResourceGovern(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  return applicationsFor(db).authorization.requireResourceGovern(actor, type, row)
}

export function requireResourceEdit(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAccess> {
  return applicationsFor(db).authorization.requireResourceEdit(actor, type, row)
}

export function getResourceAcl(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAcl> {
  return applicationsFor(db).acl.getResourceAcl(actor, type, row)
}

export interface ResourceAclWriteEffects {
  readonly afterCommit?: (db: ProviderNeutralDatabase) => void
  readonly updatedAt?: number
}

/**
 * RFC-359 W4-D23c —— 一份装配，两个数据库共用。
 *
 * 这里曾经分叉：带同步 after-write 钩子的写走 SQLite 专属的 ACL 读 / 写端口，其余走中立端口。
 * 那条尾巴的最后一个生产调用方（MCP 运行时测试失效）在 W4-D16 就已改走中立的
 * `ResourceAclMutationLifecycle`（`mcpAclRuntimeTestLifecycle`，装进 `composeResourceCatalogFor`），
 * 只剩一个测试还在自己手接旧钩子——它证明的是一处没人用的接线。测试已改指生产装配，
 * 分叉与它背后的 334 行 SQLite 专属 ACL 仓库一并退役。
 */
export function updateResourceAcl(
  db: ProviderNeutralDatabase,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  body: UpdateResourceAclBody,
  options: ResourceAclWriteEffects = {},
): Promise<ResourceAcl> {
  return applicationsFor(db).acl.updateResourceAcl(actor, type, row, body, {
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
  readonly db: ProviderNeutralDatabase
  readonly type: AclResourceType
  load(id: string): Promise<Row | null>
  readonly linearizer?: ResourceAclOperationLinearizer<Row>
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
      input.acl.updateResourceAcl(authority, input.type, row, body, {
        updatedAt,
        // 每一次 ACL 写入都从这里唤醒实时订阅（与 SQLite 旧路径 / foreign 路径同一处）：被升档、降档的观众不刷新
        // 页面也要拿到新的控件。provider 路径此前漏了这一发，D15 把 Workflow 装配切过来后 rfc324 e2e 立刻变红。
        afterCommit: async () => {
          triggerRevalidation('resource-acl-changed')
        },
      }),
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
