import {
  CreateAgentSchema,
  RenameAgentSchema,
  UpdateAgentSchema,
  type Agent,
  type CreateAgent,
  type UpdateAgent,
} from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '@/modules/execution-contract/public/commands'
import { ConflictError, NotFoundError } from '@/util/errors'

export interface DigitalEmployeeAgentTemplateFence {
  readonly expectedUpdatedAt: number
  readonly expectedAclRevision: number
}

export interface CreateDigitalEmployeeAgentTemplateRecord {
  readonly id: string
  readonly definition: CreateAgent
}

export interface RenameDigitalEmployeeAgentTemplateRecord extends DigitalEmployeeAgentTemplateFence {
  readonly id: string
  readonly newName: string
}

export interface UpdateDigitalEmployeeAgentTemplateRecord extends DigitalEmployeeAgentTemplateFence {
  readonly id: string
  readonly patch: UpdateAgent
}

/** Provider-owned Agent persistence atoms; no actor or database shape crosses this port. */
export interface DigitalEmployeeAgentTemplateRepository {
  get(id: string): Promise<Agent | null>
  createBuiltin(input: CreateDigitalEmployeeAgentTemplateRecord): Promise<void>
  renameBuiltin(input: RenameDigitalEmployeeAgentTemplateRecord): Promise<void>
  updateBuiltin(input: UpdateDigitalEmployeeAgentTemplateRecord): Promise<void>
}

/** Structural input accepted only by the Digital Employee owner-minted participant factory. */
export interface DigitalEmployeeAgentTemplateCatalogPersistencePort {
  get(id: string): Promise<Agent | null>
  createBuiltin(id: string, definition: CreateAgent): Promise<void>
  renameBuiltin(id: string, newName: string): Promise<void>
  updateBuiltin(id: string, patch: Omit<CreateAgent, 'name'>): Promise<void>
}

function requiredId(id: string): string {
  if (id.length === 0) throw new Error('digital employee Agent template id is required')
  return id
}

function requireSystemBuiltin(id: string, agent: Agent | null): Agent {
  if (agent === null) throw new NotFoundError('agent-not-found', 'agent not found')
  if (agent.ownerUserId !== SYSTEM_USER_ID || agent.builtin !== true) {
    throw new ConflictError(
      'builtin-agent-id-collision',
      `stable digital employee Agent id '${id}' is occupied`,
    )
  }
  return agent
}

/**
 * Convert the code-owned complete definition into an explicit replacement
 * patch. Empty optional sidecars and a null runtime deliberately clear drift;
 * sparse ordinary Agent PATCH semantics would otherwise retain stale fields.
 */
function completeContentPatch(current: Agent, submitted: Omit<CreateAgent, 'name'>): UpdateAgent {
  const target = CreateAgentSchema.parse({ name: current.name, ...submitted })
  return reconcileUpdatedAgentExecutionContractPorts(
    current,
    UpdateAgentSchema.parse({
      description: target.description,
      outputs: target.outputs,
      outputKinds: target.outputKinds ?? {},
      branchPorts: target.branchPorts ?? [],
      inputs: target.inputs ?? [],
      outputWrapperPortNames: target.outputWrapperPortNames ?? {},
      role: target.role ?? 'normal',
      syncOutputsOnIterate: target.syncOutputsOnIterate,
      runtime: target.runtime ?? null,
      permission: target.permission,
      skills: target.skills,
      dependsOn: target.dependsOn,
      mcp: target.mcp,
      plugins: target.plugins,
      frontmatterExtra: target.frontmatterExtra,
      bodyMd: target.bodyMd,
    }),
  )
}

/**
 * Resource Catalog application boundary for Digital Employee's owner-minted
 * capability. Providers receive normalized writes plus an exact Agent fence.
 */
export function createDigitalEmployeeAgentTemplateCatalogPersistence(
  repository: DigitalEmployeeAgentTemplateRepository,
): DigitalEmployeeAgentTemplateCatalogPersistencePort {
  return Object.freeze({
    get: (id: string) => repository.get(requiredId(id)),

    async createBuiltin(id: string, definition: CreateAgent): Promise<void> {
      await repository.createBuiltin({
        id: requiredId(id),
        definition: reconcileCreatedAgentExecutionContractPorts(
          CreateAgentSchema.parse(definition),
        ),
      })
    },

    async renameBuiltin(id: string, newName: string): Promise<void> {
      id = requiredId(id)
      const current = requireSystemBuiltin(id, await repository.get(id))
      const rename = RenameAgentSchema.parse({ newName })
      if (rename.newName === current.name) return
      await repository.renameBuiltin({
        id,
        newName: rename.newName,
        expectedUpdatedAt: current.updatedAt,
        expectedAclRevision: current.aclRevision ?? 0,
      })
    },

    async updateBuiltin(id: string, patch: Omit<CreateAgent, 'name'>): Promise<void> {
      id = requiredId(id)
      const current = requireSystemBuiltin(id, await repository.get(id))
      await repository.updateBuiltin({
        id,
        patch: completeContentPatch(current, patch),
        expectedUpdatedAt: current.updatedAt,
        expectedAclRevision: current.aclRevision ?? 0,
      })
    },
  })
}
