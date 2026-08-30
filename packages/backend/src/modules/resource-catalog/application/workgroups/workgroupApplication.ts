import {
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  DeleteWorkgroupSchema,
  RenameWorkgroupSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { assertInitialResourceOwner, initialPrivateResourceAcl } from '../resourceDefaults'
import type { WorkgroupCommands } from '../../public/commands'
import type { WorkgroupOperationContext } from '../../public/participants'
import type { WorkgroupQueries } from '../../public/queries'
import type {
  CopyWorkgroupCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteWorkgroupCatalogInput,
  GetWorkgroupCatalogInput,
  RenameWorkgroupCatalogInput,
  UpdateWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  WorkgroupCatalogResource,
} from '../../public/types'
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

export interface WorkgroupApplication {
  readonly commands: WorkgroupCommands
  readonly queries: WorkgroupQueries
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
}

function assertDeleteConfirm(input: DeleteWorkgroupCatalogInput, expectedName: string): void {
  if (typeof input.deletion.confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      'type the workgroup name to confirm deletion',
      { resourceType: 'workgroup' },
    )
  }
  if (input.deletion.confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this workgroup',
      { resourceType: 'workgroup' },
    )
  }
}

export function createWorkgroupApplication(
  deps: WorkgroupApplicationDependencies,
): WorkgroupApplication {
  async function loadVisible(
    authority: WorkgroupOperationContext,
    id: string,
  ): Promise<WorkgroupCatalogDetail> {
    const workgroup = await deps.repository.get(id)
    if (workgroup === null || !(await deps.access.canView(authority, workgroup))) {
      throw notFound(id)
    }
    return Object.freeze({ ...workgroup })
  }

  const queries: WorkgroupQueries = Object.freeze({
    async list(authority: WorkgroupOperationContext): Promise<readonly WorkgroupCatalogResource[]> {
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

  const commands: WorkgroupCommands = Object.freeze({
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
      const deletion = DeleteWorkgroupSchema.parse(input.deletion)
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceGovern(authority, current)
      assertDeleteConfirm({ id: input.id, deletion }, current.name)
      const result = await deps.repository.delete(authority, { id: input.id, deletion })
      deps.events.deleted(result)
      return result.receipt
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
