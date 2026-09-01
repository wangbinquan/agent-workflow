import {
  UpdateResourceAclBodySchema,
  type AclResourceType,
  type ResourceAcl,
  type ResourceVisibility,
  type UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { GetResourceAclCatalogInput, UpdateResourceAclCatalogInput } from '../public/types'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  hasResourceAclBypass,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
} from '../domain/resourceAccess'
import type {
  ResourceCatalogAclMutationChange,
  ResourceCatalogAclMutationPort,
  ResourceCatalogAclReadPort,
  ResourceCatalogOwnedAclType,
} from './ports/providerResourceCatalogPersistence'
import type { ResourceAuthorizationApplication } from './resourceAuthorization'

export interface ResourceAclWriteEffects<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  readonly updatedAt?: number
  afterCommit?(change: ResourceCatalogAclMutationChange<Type>): void | Promise<void>
}

export interface ResourceAclApplicationDependencies<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  readonly authorization: Pick<ResourceAuthorizationApplication, 'requireResourceGovern'>
  readonly mutation: ResourceCatalogAclMutationPort<Type>
  readonly read: ResourceCatalogAclReadPort<Type>
}

/**
 * Provider-neutral ACL use case for resource-catalog-owned aggregates.  The
 * application computes one closed decision over a transaction snapshot; each
 * infrastructure adapter owns how that decision is read and committed.
 */
export function createResourceAclApplication<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
>({ authorization, mutation, read }: ResourceAclApplicationDependencies<Type>) {
  async function getResourceAcl(actor: Actor, type: Type, row: AclRow): Promise<ResourceAcl> {
    const snapshot = await read.readSnapshot(type, row.id, row)
    if (snapshot === null) throw new NotFoundError('not-found', `${type} not found`)
    const { aclRevision, grants: grantRows, users: byId } = snapshot
    const current = snapshot.identity
    const owner =
      current.ownerUserId != null && current.ownerUserId !== SYSTEM_USER_ID
        ? (byId.get(current.ownerUserId) ?? null)
        : null
    const grants = grantRows.flatMap(({ userId, level }) => {
      const user = byId.get(userId)
      return user === undefined ? [] : [{ user, level }]
    })
    const selfGrant = grantRows.find((grant) => grant.userId === actor.user.id)?.level ?? null
    const selfAccess = resolveResourceAccess(actor, current, selfGrant)
    return {
      resourceType: type,
      resourceId: current.id,
      ownerUserId: current.ownerUserId ?? null,
      owner,
      visibility: current.visibility ?? 'public',
      grants,
      canManage: canGovernAccess(selfAccess),
      canEdit: canEditAccess(selfAccess),
      aclRevision,
    }
  }

  async function updateResourceAcl(
    actor: Actor,
    type: Type,
    row: AclRow,
    body: UpdateResourceAclBody,
    options: ResourceAclWriteEffects<Type> = {},
  ): Promise<ResourceAcl> {
    await authorization.requireResourceGovern(actor, type, row)

    const referenced = new Set<string>((body.grants ?? []).map((grant) => grant.userId))
    if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)
    const now = options.updatedAt ?? Date.now()
    const nextOwnerCandidate = body.ownerUserId

    let updated:
      | {
          readonly id: string
          readonly ownerUserId: string | null
          readonly visibility: ResourceVisibility
          readonly aclRevision: number
          readonly grantedUserIds: ReadonlySet<string>
        }
      | undefined
    try {
      updated = await mutation.mutate(
        {
          type,
          resourceId: row.id,
          actorUserId: actor.user.id,
          referencedUserIds: [...referenced],
          candidateOwnerUserId: nextOwnerCandidate,
        },
        (snapshot) => {
          const current = snapshot.current
          const access = resolveAccessFrom(
            resourceAclAudienceAuthority(actor),
            actor.user.id,
            current,
            snapshot.actorGrantLevel,
          )
          if (!canViewAccess(access)) {
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

          const invalid = [...referenced].filter(
            (userId) => userId === SYSTEM_USER_ID || !snapshot.activeUserIds.has(userId),
          )
          if (invalid.length > 0) {
            throw new ValidationError('acl-user-invalid', 'referenced user(s) not active', {
              userIds: invalid,
            })
          }

          const previousOwner = current.ownerUserId
          const nextOwner = body.ownerUserId ?? previousOwner
          const nextVisibility = body.visibility ?? current.visibility
          if (nextOwner !== previousOwner && nextOwner !== null && snapshot.ownerNameCollision) {
            throw new ConflictError(
              'resource-name-conflict',
              `${type} '${current.name}' already exists for the target owner`,
              { resourceType: type, name: current.name, ownerUserId: nextOwner },
            )
          }

          const nextGrants =
            body.grants === undefined
              ? new Map(snapshot.currentGrants)
              : new Map(body.grants.map((grant) => [grant.userId, grant.level] as const))
          if (
            nextOwner !== previousOwner &&
            previousOwner !== null &&
            previousOwner !== SYSTEM_USER_ID &&
            !nextGrants.has(previousOwner)
          ) {
            nextGrants.set(previousOwner, 'read')
          }
          if (nextOwner !== null) nextGrants.delete(nextOwner)

          const aclRevision = current.aclRevision + 1
          const grantedUserIds = new Set(nextGrants.keys())
          return {
            update: {
              ownerUserId: nextOwner,
              visibility: nextVisibility,
              aclRevision,
              updatedAt: now,
            },
            grants: nextGrants,
            addedBy: actor.user.id,
            addedAt: now,
            result: {
              id: row.id,
              ownerUserId: nextOwner,
              visibility: nextVisibility,
              aclRevision,
              grantedUserIds,
            },
          }
        },
      )
    } catch (error) {
      if (nextOwnerCandidate !== undefined && mutation.isOwnerNameConstraintError(error)) {
        const resourceName = 'name' in row && typeof row.name === 'string' ? row.name : row.id
        throw new ConflictError(
          'resource-name-conflict',
          `${type} '${resourceName}' already exists for the target owner`,
          {
            resourceType: type,
            name: resourceName,
            ownerUserId: nextOwnerCandidate,
          },
        )
      }
      throw error
    }

    if (updated === undefined) throw new NotFoundError('not-found', `${type} not found`)
    await options.afterCommit?.({
      type,
      resourceId: updated.id,
      ownerUserId: updated.ownerUserId,
      visibility: updated.visibility,
      aclRevision: updated.aclRevision,
      grantedUserIds: updated.grantedUserIds,
      now,
    })
    return getResourceAcl(actor, type, updated)
  }

  return Object.freeze({ getResourceAcl, updateResourceAcl })
}

export type ResourceAclApplication<Type extends AclResourceType = ResourceCatalogOwnedAclType> =
  ReturnType<typeof createResourceAclApplication<Type>>

export interface ResourceAclOperationLinearizer<Row extends AclRow> {
  runExclusive(resourceId: string, task: () => Promise<ResourceAcl>): Promise<ResourceAcl>
  loadById(resourceId: string): Promise<Row | null>
  nextUpdatedAt?: (row: Row) => Promise<number>
}

export interface ResourceAclOperationApplicationDependencies<
  Context extends Actor,
  Row extends AclRow,
> {
  readonly type: AclResourceType
  load(id: string): Promise<Row | null>
  canView(authority: Context, row: Row): Promise<boolean>
  assertMutable(row: Row): void
  read(authority: Context, row: Row): Promise<ResourceAcl>
  update(
    authority: Context,
    row: Row,
    body: UpdateResourceAclBody,
    updatedAt?: number,
  ): Promise<ResourceAcl>
  readonly linearizer?: ResourceAclOperationLinearizer<Row>
  afterUpdated?(resourceId: string): void | Promise<void>
}

function parseResourceAclSubmission(input: UpdateResourceAclCatalogInput): UpdateResourceAclBody {
  let body: unknown
  try {
    body = JSON.parse(input.submission.body)
  } catch {
    body = {}
  }
  const parsed = UpdateResourceAclBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('acl-invalid', 'invalid acl payload', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

/**
 * Classic-six transport-neutral ACL use cases. The application deliberately
 * loads visibility before parsing the closed submission, then repeats the
 * visibility and built-in checks on the linearized row before the existing
 * govern/CAS transaction.
 */
export function createResourceAclOperationApplication<Context extends Actor, Row extends AclRow>(
  deps: ResourceAclOperationApplicationDependencies<Context, Row>,
) {
  const notFound = (): NotFoundError =>
    new NotFoundError(`${deps.type}-not-found`, `${deps.type} not found`)

  async function loadVisible(authority: Context, id: string): Promise<Row> {
    const row = await deps.load(id)
    if (row === null || !(await deps.canView(authority, row))) throw notFound()
    return row
  }

  const queries = Object.freeze({
    async get(authority: Context, input: GetResourceAclCatalogInput): Promise<ResourceAcl> {
      return deps.read(authority, await loadVisible(authority, input.id))
    },
  })

  const commands = Object.freeze({
    async update(authority: Context, input: UpdateResourceAclCatalogInput): Promise<ResourceAcl> {
      const row = await loadVisible(authority, input.id)
      const body = parseResourceAclSubmission(input)
      const updateFresh = async (fresh: Row): Promise<ResourceAcl> => {
        if (!(await deps.canView(authority, fresh))) throw notFound()
        deps.assertMutable(fresh)
        const updatedAt = await deps.linearizer?.nextUpdatedAt?.(fresh)
        return deps.update(authority, fresh, body, updatedAt)
      }
      const result =
        deps.linearizer === undefined
          ? await updateFresh(row)
          : await deps.linearizer.runExclusive(row.id, async () => {
              const fresh = await deps.linearizer!.loadById(row.id)
              if (fresh === null) throw notFound()
              return updateFresh(fresh)
            })
      await deps.afterUpdated?.(row.id)
      return result
    },
  })

  return Object.freeze({ commands, queries })
}
