import {
  CreateAgentSchema,
  DeleteAgentSchema,
  RenameAgentRequestSchema,
  UpdateAgentRequestSchema,
  type Agent,
  type DeleteAgent,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { assertInitialResourceOwner } from '../resourceDefaults'
import type {
  CreateAgentCatalogInput,
  DeleteAgentCatalogInput,
  DeleteAgentCatalogReceipt,
  RenameAgentCatalogInput,
  UpdateAgentCatalogInput,
} from '../../public/types'
import type { AgentOperationContext } from '../../public/participants'
import type {
  AgentDependencyQueries,
  AgentQueries,
  AgentReferenceQueries,
} from '../../public/queries'
import type {
  AgentCatalogResource,
  GetAgentCatalogInput,
  AgentReferenceLabelsInput,
  ResolveAgentDependencyClosureInput,
  ResolveAgentDependencyIdsInput,
  ResolvedAgentDependencyIds,
  ValidateAgentDependenciesInput,
} from '../../public/types'
import type { AgentAccessPort, AgentPolicyPort, AgentRepository } from './ports'
import {
  resolveAgentDependencyClosure,
  validateAgentDependencies,
} from './agentDependencyValidation'

export interface AgentApplicationDependencies {
  readonly repository: AgentRepository
  readonly access: AgentAccessPort
  readonly policy: AgentPolicyPort
}

function notFound(): NotFoundError {
  return new NotFoundError('agent-not-found', 'agent not found')
}

function parseJsonSubmission(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return {}
  }
}

function parseDeleteJsonSubmission(body: string): unknown {
  if (body.trim() === '') return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

function isRuntimeOnlyAgentPatch(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const keys = Object.keys(body).filter(
    (key) => key !== 'expectedUpdatedAt' && key !== 'expectedAclRevision',
  )
  return keys.length === 1 && keys[0] === 'runtime'
}

function parseUpdateSubmission(input: UpdateAgentCatalogInput) {
  const body = parseJsonSubmission(input.submission.body)
  const parsed = UpdateAgentRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('agent-invalid', 'invalid agent patch', {
      issues: parsed.error.issues,
    })
  }
  return { body, update: parsed.data }
}

function parseDeleteSubmission(body: unknown): DeleteAgent {
  const parsed = DeleteAgentSchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('agent-delete-invalid', 'invalid agent delete payload', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

function assertDeleteConfirm(input: unknown, expectedName: string): void {
  const confirm =
    typeof input === 'object' && input !== null && 'confirm' in input
      ? (input as { readonly confirm?: unknown }).confirm
      : undefined
  if (typeof confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      'type the agent name to confirm deletion',
      {
        resourceType: 'agent',
      },
    )
  }
  if (confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this agent',
      { resourceType: 'agent' },
    )
  }
}

const resourceOf = (agent: Agent): AgentCatalogResource => Object.freeze({ ...agent })

export function createAgentApplication(deps: AgentApplicationDependencies) {
  async function loadVisible(
    authority: AgentOperationContext,
    id: string,
  ): Promise<AgentCatalogResource> {
    const agent = await deps.repository.get(id)
    if (agent === null || !(await deps.access.canView(authority, agent))) throw notFound()
    return resourceOf(agent)
  }

  const queries: AgentQueries = Object.freeze({
    async list(authority: AgentOperationContext): Promise<readonly AgentCatalogResource[]> {
      const managed = deps.policy.excludeBuiltin(await deps.repository.list())
      const visible = await deps.access.filterVisible(authority, managed)
      return visible.map(resourceOf)
    },
    async get(
      authority: AgentOperationContext,
      input: GetAgentCatalogInput,
    ): Promise<AgentCatalogResource | null> {
      const agent = await deps.repository.get(input.id)
      if (agent === null || !(await deps.access.canView(authority, agent))) return null
      return resourceOf(agent)
    },
  })

  const referenceQueries: AgentReferenceQueries = Object.freeze({
    labels: (authority: AgentOperationContext, input: AgentReferenceLabelsInput) =>
      deps.repository.referenceLabels(authority, input),
  })

  const dependencyQueries: AgentDependencyQueries = Object.freeze({
    closure: (_authority: AgentOperationContext, input: ResolveAgentDependencyClosureInput) =>
      resolveAgentDependencyClosure(deps.repository, input),
    async resolveUsableIds(
      authority: AgentOperationContext,
      input: ResolveAgentDependencyIdsInput,
    ): Promise<ResolvedAgentDependencyIds> {
      const ids: string[] = []
      const missing: Array<{ readonly type: 'agent'; readonly name: string }> = []
      const seen = new Set<string>()
      for (const id of input.ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const agent = await deps.repository.get(id)
        if (agent === null) {
          ids.push(id)
          continue
        }
        if (!(await deps.access.canView(authority, agent))) {
          missing.push(Object.freeze({ type: 'agent', name: id }))
        }
        ids.push(agent.id)
      }
      return Object.freeze({ ids: Object.freeze(ids), missing: Object.freeze(missing) })
    },
    async validate(
      _authority: AgentOperationContext,
      input: ValidateAgentDependenciesInput,
    ): Promise<void> {
      await validateAgentDependencies(deps.repository, input.selfId, input.dependsOn)
    },
  })

  const commands = Object.freeze({
    async create(
      authority: AgentOperationContext,
      input: CreateAgentCatalogInput,
    ): Promise<AgentCatalogResource> {
      const parsed = CreateAgentSchema.safeParse(input)
      if (!parsed.success) {
        throw new ValidationError('agent-invalid', 'invalid agent payload', {
          issues: parsed.error.issues,
        })
      }
      assertInitialResourceOwner(authority, authority.user.id)
      return resourceOf(await deps.repository.create(authority, parsed.data))
    },
    async update(
      authority: AgentOperationContext,
      input: UpdateAgentCatalogInput,
    ): Promise<AgentCatalogResource> {
      const { body, update } = parseUpdateSubmission(input)
      const current = await loadVisible(authority, input.id)
      if (!(current.builtin === true && isRuntimeOnlyAgentPatch(body))) {
        deps.policy.assertMutable(current)
      }
      await deps.access.requireResourceEdit(authority, current)
      const { expectedUpdatedAt, expectedAclRevision, ...patch } = update
      return resourceOf(
        await deps.repository.update(authority, current.id, patch, {
          expectedUpdatedAt,
          expectedAclRevision,
        }),
      )
    },
    async delete(
      authority: AgentOperationContext,
      input: DeleteAgentCatalogInput,
    ): Promise<DeleteAgentCatalogReceipt> {
      const current = await loadVisible(authority, input.id)
      deps.policy.assertMutable(current)
      await deps.access.requireResourceGovern(authority, current)
      const body = parseDeleteJsonSubmission(input.submission.body)
      assertDeleteConfirm(body, current.name)
      const deletion = parseDeleteSubmission(body)
      await deps.repository.delete(authority, current.id, deletion)
      return Object.freeze({ deleted: current })
    },
    async rename(
      authority: AgentOperationContext,
      input: RenameAgentCatalogInput,
    ): Promise<AgentCatalogResource> {
      const parsed = RenameAgentRequestSchema.safeParse(input.rename)
      if (!parsed.success) {
        throw new ValidationError('agent-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const current = await loadVisible(authority, input.id)
      deps.policy.assertMutable(current)
      await deps.access.requireResourceGovern(authority, current)
      const { expectedUpdatedAt, expectedAclRevision, ...rename } = parsed.data
      return resourceOf(
        await deps.repository.rename(authority, current.id, rename, {
          expectedUpdatedAt,
          expectedAclRevision,
        }),
      )
    },
  })

  return Object.freeze({ commands, queries, referenceQueries, dependencyQueries })
}
