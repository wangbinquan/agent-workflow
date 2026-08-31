import {
  CopyWorkflowRequestSchema,
  CreateWorkflowSchema,
  DeleteWorkflowSchema,
  UpdateWorkflowSchema,
  type DeleteWorkflow,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { assertInitialResourceOwner } from '../resourceDefaults'
import type { WorkflowCommands } from '../../public/commands'
import type { WorkflowOperationContext } from '../../public/participants'
import type { WorkflowQueries } from '../../public/queries'
import type {
  CopyWorkflowCatalogInput,
  CreateWorkflowCatalogInput,
  DeleteWorkflowCatalogInput,
  DeleteWorkflowCatalogReceipt,
  GetWorkflowCatalogInput,
  UpdateWorkflowCatalogInput,
  UpdateWorkflowCatalogReceipt,
  WorkflowAclIdentity,
  WorkflowCatalogDetail,
  WorkflowCatalogResource,
} from '../../public/types'
import type { WorkflowAccessPort, WorkflowPolicyPort, WorkflowRepository } from './ports'

export interface WorkflowApplicationDependencies {
  readonly repository: WorkflowRepository
  readonly access: WorkflowAccessPort
  readonly policy: WorkflowPolicyPort
}

export interface WorkflowApplication {
  readonly commands: WorkflowCommands
  readonly queries: WorkflowQueries
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
}

function jsonOrEmpty(body: string): unknown {
  if (body.trim() === '') return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    return {}
  }
}

function parseDeleteSubmission(body: unknown): DeleteWorkflow {
  const parsed = DeleteWorkflowSchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('workflow-invalid', 'invalid workflow delete payload', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

function assertDeleteConfirm(input: DeleteWorkflow, expectedName: string): void {
  if (typeof input.confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      'type the workflow name to confirm deletion',
      { resourceType: 'workflow' },
    )
  }
  if (input.confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this workflow',
      { resourceType: 'workflow' },
    )
  }
}

export function createWorkflowApplication(
  deps: WorkflowApplicationDependencies,
): WorkflowApplication {
  async function loadVisible(
    authority: WorkflowOperationContext,
    id: string,
  ): Promise<WorkflowCatalogDetail> {
    const workflow = await deps.repository.get(id)
    if (workflow === null || !(await deps.access.canView(authority, workflow))) {
      throw notFound(id)
    }
    return workflow
  }

  async function loadVisibleIdentity(
    authority: WorkflowOperationContext,
    id: string,
  ): Promise<WorkflowAclIdentity> {
    const identity = await deps.repository.getAclIdentity(id)
    if (identity === null || !(await deps.access.canView(authority, identity))) {
      throw notFound(id)
    }
    return identity
  }

  const queries: WorkflowQueries = Object.freeze({
    async list(authority: WorkflowOperationContext): Promise<readonly WorkflowCatalogResource[]> {
      const managed = deps.policy.excludeBuiltin(await deps.repository.list())
      return deps.access.filterVisible(authority, managed)
    },
    async get(
      authority: WorkflowOperationContext,
      input: GetWorkflowCatalogInput,
    ): Promise<WorkflowCatalogDetail | null> {
      const workflow = await deps.repository.get(input.id)
      if (workflow === null || !(await deps.access.canView(authority, workflow))) return null
      return workflow
    },
  } satisfies WorkflowQueries)

  const commands: WorkflowCommands = Object.freeze({
    async create(authority: WorkflowOperationContext, input: CreateWorkflowCatalogInput) {
      const parsed = CreateWorkflowSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('workflow-invalid', 'invalid workflow payload', {
          issues: parsed.error.issues,
        })
      }
      assertInitialResourceOwner(authority, authority.user.id)
      return deps.repository.create(authority, parsed.data)
    },
    async copy(authority: WorkflowOperationContext, input: CopyWorkflowCatalogInput) {
      const copy = CopyWorkflowRequestSchema.parse(input.copy)
      const current = await loadVisible(authority, input.id)
      deps.policy.assertMutable(current)
      return deps.repository.copy(authority, current.id, copy)
    },
    async update(
      authority: WorkflowOperationContext,
      input: UpdateWorkflowCatalogInput,
    ): Promise<UpdateWorkflowCatalogReceipt> {
      const parsed = UpdateWorkflowSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('workflow-invalid', 'invalid workflow save payload', {
          issues: parsed.error.issues,
        })
      }
      const current = await loadVisible(authority, input.id)
      deps.policy.assertMutable(current)
      await deps.access.requireResourceEdit(authority, current)
      return deps.repository.update(authority, current.id, parsed.data)
    },
    async delete(
      authority: WorkflowOperationContext,
      input: DeleteWorkflowCatalogInput,
    ): Promise<DeleteWorkflowCatalogReceipt> {
      // A raw ACL identity deliberately precedes definition parsing: corrupt
      // workflow bodies must remain deletable, while invisible rows stay 404.
      const current = await loadVisibleIdentity(authority, input.id)
      deps.policy.assertMutable(current)
      await deps.access.requireResourceGovern(authority, current)
      const deletion = parseDeleteSubmission(jsonOrEmpty(input.submission.body))
      assertDeleteConfirm(deletion, current.name)
      await deps.repository.delete(authority, current.id, deletion)
      return Object.freeze({
        deleted: current,
        clientMutationId: deletion.clientMutationId,
        deletedVersion: deletion.expectedVersion,
      })
    },
  } satisfies WorkflowCommands)

  return Object.freeze({ commands, queries })
}
