import type {
  ResourceAccess,
  ResourceAcl,
  ResourceGrantLevel,
  UpdateResourceAclBody,
  UserPublic,
} from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import {
  developmentAdapterDefinitions,
  employeeDefinitions,
  employeeJobTemplates,
  employeeToolRegistrations,
  resourceGrants,
  users,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

export type ForeignResourceAclType =
  | 'development_adapter'
  | 'employee_definition'
  | 'employee_tool'
  | 'employee_job_template'

interface ForeignAclRow {
  readonly id: string
  readonly name?: string
  readonly ownerUserId?: string | null
  readonly visibility?: 'private' | 'public'
}

export interface ForeignResourceAuthorization {
  canViewResource(actor: Actor, type: ForeignResourceAclType, row: ForeignAclRow): Promise<boolean>
  requireResourceGovern(
    actor: Actor,
    type: ForeignResourceAclType,
    row: ForeignAclRow,
  ): Promise<void>
  resolveResourceAccessFor(
    actor: Actor,
    type: ForeignResourceAclType,
    row: ForeignAclRow,
  ): Promise<ResourceAccess>
}

const FOREIGN_ACL_TABLES = {
  development_adapter: developmentAdapterDefinitions,
  employee_definition: employeeDefinitions,
  employee_tool: employeeToolRegistrations,
  employee_job_template: employeeJobTemplates,
} as const

function editable(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

function constraintName(type: ForeignResourceAclType): string | null {
  switch (type) {
    case 'development_adapter':
      return 'development_adapter_definitions_owner_name_unique'
    case 'employee_definition':
      return 'employee_definitions_owner_name_unique'
    case 'employee_job_template':
      return 'employee_job_templates_owner_type_name_unique'
    case 'employee_tool':
      return null
  }
}

async function ownerNameCollision(input: {
  readonly db: Pick<PostgresqlDatabaseClient, 'select'>
  readonly type: ForeignResourceAclType
  readonly current: {
    readonly id: string
    readonly name: string
  }
  readonly nextOwnerUserId: string
}): Promise<boolean> {
  if (input.type === 'employee_tool') return false
  if (input.type === 'employee_job_template') {
    const current = await input.db
      .select({
        typeId: employeeJobTemplates.typeId,
        typeRevision: employeeJobTemplates.typeRevision,
      })
      .from(employeeJobTemplates)
      .where(eq(employeeJobTemplates.id, input.current.id))
      .get()
    if (current === undefined) return false
    return (
      (await input.db
        .select({ id: employeeJobTemplates.id })
        .from(employeeJobTemplates)
        .where(
          and(
            eq(employeeJobTemplates.ownerUserId, input.nextOwnerUserId),
            eq(employeeJobTemplates.typeId, current.typeId),
            eq(employeeJobTemplates.typeRevision, current.typeRevision),
            eq(employeeJobTemplates.name, input.current.name),
            ne(employeeJobTemplates.id, input.current.id),
          ),
        )
        .get()) !== undefined
    )
  }
  const table =
    input.type === 'development_adapter' ? developmentAdapterDefinitions : employeeDefinitions
  return (
    (await input.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.ownerUserId, input.nextOwnerUserId),
          eq(table.name, input.current.name),
          ne(table.id, input.current.id),
        ),
      )
      .get()) !== undefined
  )
}

/**
 * Provider mechanism for ACL rows owned outside Resource Catalog. The
 * authorization decision is injected from the selected provider, while this
 * adapter owns the exact foreign tables and the atomic CAS/grant replacement.
 */
export function createPostgresqlForeignResourceAclOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly authorization: ForeignResourceAuthorization
}) {
  const read = async (
    actor: Actor,
    type: ForeignResourceAclType,
    row: ForeignAclRow,
  ): Promise<ResourceAcl> => {
    if (!(await input.authorization.canViewResource(actor, type, row))) {
      throw new NotFoundError(`${type}-not-found`, `${type} not found`)
    }
    const table = FOREIGN_ACL_TABLES[type]
    const identity = await input.db
      .select({
        id: table.id,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
        aclRevision: table.aclRevision,
      })
      .from(table)
      .where(eq(table.id, row.id))
      .get()
    if (identity === undefined) {
      throw new NotFoundError(`${type}-not-found`, `${type} not found`)
    }
    const grantRows = await input.db
      .select({ userId: resourceGrants.userId, level: resourceGrants.level })
      .from(resourceGrants)
      .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, row.id)))
      .all()
    const userIds = [
      ...new Set([
        ...(identity.ownerUserId === null ? [] : [identity.ownerUserId]),
        ...grantRows.map((grant) => grant.userId),
      ]),
    ]
    const userRows: readonly UserPublic[] =
      userIds.length === 0
        ? []
        : await input.db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              role: users.role,
              status: users.status,
            })
            .from(users)
            .where(inArray(users.id, userIds))
            .all()
    const byId = new Map(userRows.map((user) => [user.id, user]))
    const access = await input.authorization.resolveResourceAccessFor(actor, type, identity)
    return Object.freeze({
      resourceType: type,
      resourceId: identity.id,
      ownerUserId: identity.ownerUserId,
      owner: identity.ownerUserId === null ? null : (byId.get(identity.ownerUserId) ?? null),
      visibility: identity.visibility,
      grants: grantRows.flatMap((grant) => {
        const user = byId.get(grant.userId)
        return user === undefined ? [] : [{ user, level: grant.level }]
      }),
      canManage: access === 'own',
      canEdit: editable(access),
      aclRevision: identity.aclRevision,
    })
  }

  const update = async (
    actor: Actor,
    type: ForeignResourceAclType,
    row: ForeignAclRow,
    body: UpdateResourceAclBody,
    updatedAt = Date.now(),
  ): Promise<ResourceAcl> => {
    await input.authorization.requireResourceGovern(actor, type, row)
    const table = FOREIGN_ACL_TABLES[type]
    const referenced = new Set((body.grants ?? []).map((grant) => grant.userId))
    if (body.ownerUserId !== undefined && body.ownerUserId !== null) {
      referenced.add(body.ownerUserId)
    }
    try {
      await input.db.transaction(async (transaction) => {
        const current = await transaction
          .select({
            id: table.id,
            name: table.name,
            ownerUserId: table.ownerUserId,
            visibility: table.visibility,
            aclRevision: table.aclRevision,
          })
          .from(table)
          .where(eq(table.id, row.id))
          .get()
        if (current === undefined) {
          throw new NotFoundError(`${type}-not-found`, `${type} not found`)
        }
        if (body.expectedResourceId !== current.id) {
          throw new ConflictError('acl-resource-mismatch', 'resource id changed; reload')
        }
        if (body.expectedAclRevision !== current.aclRevision) {
          throw new ConflictError(
            'acl-revision-conflict',
            `acl revision is ${current.aclRevision}, expected ${body.expectedAclRevision}; reload and retry`,
          )
        }
        if (
          !actor.permissions.has('resource-acl:bypass') &&
          current.ownerUserId !== actor.user.id
        ) {
          throw new ForbiddenError(
            'forbidden',
            `only the ${type} owner or an actor with resource-acl:bypass can modify it`,
          )
        }
        const activeRows =
          referenced.size === 0
            ? []
            : await transaction
                .select({ id: users.id })
                .from(users)
                .where(and(inArray(users.id, [...referenced]), eq(users.status, 'active')))
                .all()
        const active = new Set(activeRows.map((user) => user.id))
        const invalid = [...referenced].filter((userId) => !active.has(userId))
        if (invalid.length > 0) {
          throw new ValidationError('acl-user-invalid', 'referenced user(s) not active', {
            userIds: invalid,
          })
        }
        const nextOwner = body.ownerUserId ?? current.ownerUserId
        const nextVisibility = body.visibility ?? current.visibility
        if (
          nextOwner !== current.ownerUserId &&
          nextOwner !== null &&
          (await ownerNameCollision({
            db: transaction,
            type,
            current,
            nextOwnerUserId: nextOwner,
          }))
        ) {
          throw new ConflictError(
            'resource-name-conflict',
            `${type} '${current.name}' already exists for the target owner`,
          )
        }
        const existingGrants = await transaction
          .select({ userId: resourceGrants.userId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(
            and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, current.id)),
          )
          .all()
        const nextGrants =
          body.grants === undefined
            ? new Map<string, ResourceGrantLevel>(
                existingGrants.map((grant) => [grant.userId, grant.level]),
              )
            : new Map<string, ResourceGrantLevel>(
                body.grants.map((grant) => [grant.userId, grant.level]),
              )
        if (
          nextOwner !== current.ownerUserId &&
          current.ownerUserId !== null &&
          !nextGrants.has(current.ownerUserId)
        ) {
          nextGrants.set(current.ownerUserId, 'read')
        }
        if (nextOwner !== null) nextGrants.delete(nextOwner)
        const updated = await transaction
          .update(table)
          .set({
            ownerUserId: nextOwner,
            visibility: nextVisibility,
            aclRevision: current.aclRevision + 1,
            updatedAt,
          })
          .where(and(eq(table.id, current.id), eq(table.aclRevision, current.aclRevision)))
          .returning({ id: table.id })
          .get()
        if (updated === undefined) {
          throw new ConflictError(
            'acl-revision-conflict',
            'resource ACL changed while saving; reload and retry',
          )
        }
        await transaction
          .delete(resourceGrants)
          .where(
            and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, current.id)),
          )
          .run()
        if (nextGrants.size > 0) {
          await transaction
            .insert(resourceGrants)
            .values(
              [...nextGrants].map(([userId, level]) => ({
                resourceType: type,
                resourceId: current.id,
                userId,
                level,
                addedBy: actor.user.id,
                addedAt: updatedAt,
              })),
            )
            .run()
        }
      })
    } catch (error) {
      const unique = constraintName(type)
      if (unique !== null && String(error).includes(unique)) {
        throw new ConflictError(
          'resource-name-conflict',
          `${type} '${row.name ?? row.id}' already exists for the target owner`,
        )
      }
      throw error
    }
    return await read(actor, type, row)
  }

  return Object.freeze({ read, update })
}
