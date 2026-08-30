import type {
  AclResourceType,
  ResourceAcl,
  ResourceGrantLevel,
  ResourceVisibility,
  UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  canEditAccess,
  canGovernAccess,
  hasResourceAclBypass,
  resolveResourceAccess,
  type AclRow,
} from '../domain/resourceAccess'
import type {
  ResourceAclIdentityPersistence,
  ResourceAclMutationPort,
  ResourceAclReadPort,
} from './ports/resourceAclPersistence'
import type { ResourceAuthorizationApplication } from './resourceAuthorization'

export interface ResourceAclWriteEffects {
  readonly identityPersistence?: ResourceAclIdentityPersistence
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
}

export interface ResourceAclApplicationDependencies {
  readonly authorization: Pick<
    ResourceAuthorizationApplication,
    'canViewResourceInTx' | 'requireResourceGovern'
  >
  readonly mutation: ResourceAclMutationPort
  readonly read: ResourceAclReadPort
}

export function createResourceAclApplication({
  authorization,
  mutation,
  read,
}: ResourceAclApplicationDependencies) {
  async function getResourceAcl(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
    identityPersistence?: ResourceAclIdentityPersistence,
  ): Promise<ResourceAcl> {
    const [aclRevision, grantRows] = await Promise.all([
      read.getRevision(db, type, row.id, identityPersistence),
      read.listGrants(db, type, row.id),
    ])
    const wantedIds = [
      ...new Set([
        ...(row.ownerUserId ? [row.ownerUserId] : []),
        ...grantRows.map((grant) => grant.userId),
      ]),
    ]
    const byId = await read.loadUsers(db, wantedIds)
    const owner =
      row.ownerUserId != null && row.ownerUserId !== SYSTEM_USER_ID
        ? (byId.get(row.ownerUserId) ?? null)
        : null
    const grants = grantRows.flatMap(({ userId, level }) => {
      const user = byId.get(userId)
      return user === undefined ? [] : [{ user, level }]
    })
    const selfGrant = grantRows.find((grant) => grant.userId === actor.user.id)?.level ?? null
    const selfAccess = resolveResourceAccess(actor, row, selfGrant)
    return {
      resourceType: type,
      resourceId: row.id,
      ownerUserId: row.ownerUserId ?? null,
      owner,
      visibility: row.visibility ?? 'public',
      grants,
      canManage: canGovernAccess(selfAccess),
      canEdit: canEditAccess(selfAccess),
      aclRevision,
    }
  }

  async function updateResourceAcl(
    db: DbClient,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
    body: UpdateResourceAclBody,
    options: ResourceAclWriteEffects & { readonly updatedAt?: number } = {},
  ): Promise<ResourceAcl> {
    await authorization.requireResourceGovern(db, actor, type, row)

    const referenced = new Set<string>((body.grants ?? []).map((grant) => grant.userId))
    if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)
    const now = options.updatedAt ?? Date.now()

    const updatedRow = mutation.withMutation(
      db,
      type,
      row.id,
      options.identityPersistence,
      (context) => {
        const current = context.current
        if (!authorization.canViewResourceInTx(context.tx, actor, type, current)) {
          throw new NotFoundError('not-found', `${type} not found`)
        }
        if (body.expectedResourceId !== row.id) {
          throw new ConflictError('acl-resource-mismatch', 'resource id changed; reload')
        }
        if (current.aclRevision !== body.expectedAclRevision) {
          throw new ConflictError(
            'acl-revision-conflict',
            `acl revision is ${current.aclRevision}, expected ${body.expectedAclRevision}; reload and retry`,
          )
        }
        if (!hasResourceAclBypass(actor) && current.ownerUserId !== actor.user.id) {
          throw new ForbiddenError(
            'forbidden',
            `only the ${type} owner or an actor with resource-acl:bypass can modify it`,
          )
        }

        if (referenced.size > 0) {
          const active = context.activeUserIds([...referenced])
          const invalid = [...referenced].filter(
            (userId) => userId === SYSTEM_USER_ID || !active.has(userId),
          )
          if (invalid.length > 0) {
            throw new ValidationError('acl-user-invalid', 'referenced user(s) not active', {
              userIds: invalid,
            })
          }
        }

        const previousOwner = current.ownerUserId
        const nextOwner = body.ownerUserId !== undefined ? body.ownerUserId : previousOwner
        const nextVisibility: ResourceVisibility =
          body.visibility !== undefined ? body.visibility : (current.visibility ?? 'public')

        if (
          nextOwner !== previousOwner &&
          nextOwner !== null &&
          context.hasOwnerNameCollision(nextOwner)
        ) {
          throw new ConflictError(
            'resource-name-conflict',
            `${type} '${current.name}' already exists for the target owner`,
            { resourceType: type, name: current.name, ownerUserId: nextOwner },
          )
        }

        let nextGrants: Map<string, ResourceGrantLevel>
        if (body.grants !== undefined) {
          nextGrants = new Map(body.grants.map((grant) => [grant.userId, grant.level] as const))
        } else {
          nextGrants = mutation.listGrantsInTx(context.tx, type, row.id)
        }
        if (
          nextOwner !== previousOwner &&
          previousOwner !== null &&
          previousOwner !== SYSTEM_USER_ID &&
          !nextGrants.has(previousOwner)
        ) {
          nextGrants.set(previousOwner, 'read')
        }
        if (nextOwner !== null) nextGrants.delete(nextOwner)

        try {
          context.updateAclRow({
            ownerUserId: nextOwner,
            visibility: nextVisibility,
            aclRevision: current.aclRevision + 1,
            updatedAt: now,
          })
        } catch (error) {
          if (
            nextOwner !== previousOwner &&
            context.ownerNameIsUnique &&
            mutation.isOwnerNameConstraintError(error)
          ) {
            throw new ConflictError(
              'resource-name-conflict',
              `${type} '${current.name}' already exists for the target owner`,
              { resourceType: type, name: current.name, ownerUserId: nextOwner },
            )
          }
          throw error
        }
        context.replaceGrants(nextGrants, actor.user.id, now)
        options.afterWriteInTx?.(context.tx, {
          resourceId: row.id,
          ownerUserId: nextOwner,
          visibility: nextVisibility,
          grantedUserIds: new Set(nextGrants.keys()),
          now,
        })
        return { id: row.id, ownerUserId: nextOwner, visibility: nextVisibility }
      },
    )

    if (updatedRow === undefined) throw new NotFoundError('not-found', `${type} not found`)
    options.afterCommit?.(db)
    return getResourceAcl(db, actor, type, updatedRow, options.identityPersistence)
  }

  return { getResourceAcl, updateResourceAcl }
}

export type ResourceAclApplication = ReturnType<typeof createResourceAclApplication>
