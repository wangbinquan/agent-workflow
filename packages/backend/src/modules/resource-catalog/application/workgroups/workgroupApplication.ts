import {
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  DeleteWorkgroupSchema,
  RenameWorkgroupSchema,
  UpdateWorkgroupSchema,
  type DeleteWorkgroup,
  type Workgroup,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { assertInitialResourceOwner, initialPrivateResourceAcl } from '../resourceDefaults'
import type {
  CopyWorkgroupCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteWorkgroupCatalogInput,
  RenameWorkgroupCatalogInput,
  UpdateWorkgroupCatalogInput,
} from '../../domain/catalogOperationTypes'
import type { WorkgroupOperationContext } from '../../public/participants'
import type { WorkgroupQueries } from '../../public/queries'
import type { GetWorkgroupCatalogInput, WorkgroupCatalogDetail } from '../../public/types'
import type {
  WorkgroupAccessPort,
  WorkgroupEventsPort,
  WorkgroupIdFactory,
  WorkgroupMutationClock,
  WorkgroupProjection,
  WorkgroupRepository,
} from './ports'

export interface WorkgroupApplicationDependencies {
  readonly repository: WorkgroupRepository
  readonly projection: WorkgroupProjection
  readonly access: WorkgroupAccessPort
  readonly events: WorkgroupEventsPort
  readonly ids: WorkgroupIdFactory
  readonly clock: WorkgroupMutationClock
}

function notFound(): NotFoundError {
  return new NotFoundError('workgroup-not-found', 'workgroup not found')
}

function assertDeleteConfirm(input: DeleteWorkgroup, expectedName: string): void {
  if (typeof input.confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      'type the workgroup name to confirm deletion',
      { resourceType: 'workgroup' },
    )
  }
  if (input.confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this workgroup',
      { resourceType: 'workgroup' },
    )
  }
}

function parseDeleteWorkgroupSubmission(
  input: DeleteWorkgroupCatalogInput['deletion'],
): DeleteWorkgroup {
  let body: unknown = {}
  try {
    body = JSON.parse(input.body)
  } catch {
    // Preserve safeJsonOrEmpty's historical malformed/empty-body semantics.
  }
  const parsed = DeleteWorkgroupSchema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('workgroup-invalid', 'invalid workgroup delete payload', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

export function createWorkgroupApplication(deps: WorkgroupApplicationDependencies) {
  async function loadVisible(
    authority: WorkgroupOperationContext,
    id: string,
  ): Promise<WorkgroupCatalogDetail> {
    const workgroup = await deps.repository.get(id)
    if (workgroup === null || !(await deps.access.canView(authority, workgroup))) {
      throw notFound()
    }
    return Object.freeze({ ...workgroup })
  }

  const queries: WorkgroupQueries = Object.freeze({
    async list(authority: WorkgroupOperationContext): Promise<readonly Workgroup[]> {
      const visible = await deps.access.filterVisible(authority, await deps.repository.list())
      return visible.map((workgroup) => deps.projection.resourceOf(workgroup))
    },
    async get(
      authority: WorkgroupOperationContext,
      input: GetWorkgroupCatalogInput,
    ): Promise<WorkgroupCatalogDetail | null> {
      const workgroup = await deps.repository.get(input.id)
      if (workgroup === null || !(await deps.access.canView(authority, workgroup))) return null
      return Object.freeze({ ...workgroup })
    },
  })

  const commands = Object.freeze({
    async create(
      authority: WorkgroupOperationContext,
      input: CreateWorkgroupCatalogInput,
    ): Promise<WorkgroupCatalogDetail> {
      const document = CreateWorkgroupSchema.parse(input)
      assertInitialResourceOwner(authority, authority.user.id)
      const created = await deps.repository.create({
        authority,
        id: deps.ids.next(),
        document,
        initialAcl: initialPrivateResourceAcl(authority.user.id),
        now: deps.clock.now(),
      })
      deps.events.created(created)
      return Object.freeze({ ...created })
    },
    async copy(
      authority: WorkgroupOperationContext,
      input: CopyWorkgroupCatalogInput,
    ): Promise<WorkgroupCatalogDetail> {
      const request = CopyWorkgroupRequestSchema.parse(input.copy)
      await loadVisible(authority, input.id)
      assertInitialResourceOwner(authority, authority.user.id)
      const created = await deps.repository.copy({
        authority,
        request: { id: input.id, copy: request },
        id: deps.ids.next(),
        initialAcl: initialPrivateResourceAcl(authority.user.id),
        now: deps.clock.now(),
      })
      deps.events.created(created)
      return Object.freeze({ ...created })
    },
    async update(authority: WorkgroupOperationContext, input: UpdateWorkgroupCatalogInput) {
      const update = UpdateWorkgroupSchema.parse(input.update)
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, current)
      const result = await deps.repository.save(authority, { id: input.id, update })
      if (result.committed) deps.events.updated(result.receipt)
      return result.receipt
    },
    async delete(authority: WorkgroupOperationContext, input: DeleteWorkgroupCatalogInput) {
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceGovern(authority, current)
      const deletion = parseDeleteWorkgroupSubmission(input.deletion)
      assertDeleteConfirm(deletion, current.name)
      const result = await deps.repository.delete(authority, { id: input.id, deletion })
      deps.events.deleted(result)
      return Object.freeze({ ...result.receipt, deleted: Object.freeze({ ...current }) })
    },
    async rename(authority: WorkgroupOperationContext, input: RenameWorkgroupCatalogInput) {
      const rename = RenameWorkgroupSchema.parse(input.rename)
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceGovern(authority, current)
      const snapshot = deps.projection.snapshotOf(current)
      const result = await deps.repository.save(authority, {
        id: current.id,
        update: {
          expectedVersion: rename.expectedVersion,
          clientMutationId: rename.clientMutationId,
          snapshot: {
            ...snapshot,
            name: rename.newName,
            description: rename.description ?? snapshot.description,
          },
        },
      })
      if (result.committed) deps.events.updated(result.receipt)
      return result.receipt
    },
  })

  return Object.freeze({ commands, queries })
}
