// RFC-395 II-b package O2: keep legacy deletion test inputs while exercising the module repositories.
import {
  DeleteWorkflowSchema,
  DeleteWorkgroupSchema,
  type DeleteWorkflow,
  type DeleteWorkgroup,
} from '@agent-workflow/shared'
import { buildActor, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseAgentResourceInventorySource } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { getAgentById } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { workflowBroadcastEvents } from '@/modules/resource-catalog/composition/workflowOperations'
import { createWorkgroupRepository } from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import {
  workgroupRepositoryDependencies,
  createWorkgroupEvents,
} from '@/modules/resource-catalog/composition/workgroupOperations'
import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import { NotFoundError, ValidationError } from '@/util/errors'
import { assertNotBuiltin } from '@/services/systemResources'

function authority(actor: Actor) {
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
}

type Principal =
  | { readonly kind: 'actor'; readonly actor: Actor }
  | { readonly kind: 'system'; readonly reason?: string }
function principalActor(principal: Principal) {
  return authority(
    principal.kind === 'actor'
      ? principal.actor
      : buildActor({
          user: {
            id: SYSTEM_USER_ID,
            username: 'system',
            displayName: 'System',
            role: 'admin',
            status: 'active',
          },
          source: 'daemon',
        }),
  )
}

export async function deleteAgent(
  db: PersistenceDb,
  id: string,
  actor: Actor,
  fence?: { expectedUpdatedAt: number; expectedAclRevision: number },
): Promise<void> {
  const current = await getAgentById(db, id)
  if (current === null) throw new NotFoundError('agent-not-found', 'agent not found')
  const catalog = composeResourceCatalogFor({ db })
  const context = authority(actor)
  // Fenced legacy calls exercised govern access; unfenced fixtures entered the repository directly.
  if (fence !== undefined) {
    // Match the retired requireAgentMutationRevisionTx and the production application:
    // invisible and absent Agents both retain the resource-specific 404 code.
    if (!(await catalog.authorization.canViewResource(context, 'agent', current)))
      throw new NotFoundError('agent-not-found', 'agent not found')
    await catalog.authorization.requireResourceGovern(context, 'agent', current)
  }
  const repository = createAgentRepository({
    db,
    semantics: createAgentPersistenceSemantics({
      db,
      authorization: catalog.authorization,
      resourceInventory: composeDatabaseAgentResourceInventorySource({
        db,
        authorization: catalog.authorization,
      }),
      runtimeProfiles: { get: async () => null },
      taskReferences: composeSubjectTaskReferencePort,
    }),
  })
  await repository.delete(
    context,
    id,
    fence ?? {
      expectedUpdatedAt: current.updatedAt,
      expectedAclRevision: current.aclRevision ?? 0,
    },
  )
}

export async function deleteWorkflow(
  db: PersistenceDb,
  id: string,
  input: DeleteWorkflow,
  principal: Principal,
): Promise<void> {
  const parsed = DeleteWorkflowSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError('workflow-invalid', 'invalid workflow delete payload', {
      issues: parsed.error.issues,
    })
  const catalog = composeResourceCatalogFor({ db })
  const context = principalActor(principal)
  const repository = createWorkflowRepository({
    db,
    semantics: createWorkflowPersistenceSemantics({
      authorization: catalog.authorization,
      taskReferences: composeSubjectTaskReferencePort,
      events: workflowBroadcastEvents(),
    }),
  })
  const current = await repository.getAclIdentity(id)
  if (
    current === null ||
    !(await catalog.authorization.canViewResource(context, 'workflow', current))
  )
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  assertNotBuiltin('workflow', current)
  await catalog.authorization.requireResourceGovern(context, 'workflow', current)
  await repository.delete(context, id, parsed.data)
}

export async function deleteWorkgroup(
  db: PersistenceDb,
  id: string,
  input: DeleteWorkgroup,
  principal: Principal,
): Promise<void> {
  const parsed = DeleteWorkgroupSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError('workgroup-invalid', 'invalid workgroup delete payload', {
      issues: parsed.error.issues,
    })
  const { repository } = createWorkgroupRepository(
    db,
    workgroupRepositoryDependencies({ db, taskReferences: composeSubjectTaskReferencePort }),
  )
  const result = await repository.delete(principalActor(principal), { id, deletion: parsed.data })
  createWorkgroupEvents().deleted(result)
}
