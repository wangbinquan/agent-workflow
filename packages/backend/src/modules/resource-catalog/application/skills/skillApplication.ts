import {
  CombinedSaveSkillSchema,
  CreateManagedSkillSchema,
  DeleteSkillSchema,
  RestoreSkillVersionSchema,
  WriteSkillFileSchema,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import type {
  CreateSkillCatalogInput,
  DeleteSkillCatalogInput,
  DeleteSkillCatalogReceipt,
  SaveSkillCatalogInput,
} from '../../domain/catalogOperationTypes'
import type { SkillFileCommands, SkillVersionCommands } from '../../public/commands'
import type { SkillOperationContext } from '../../public/participants'
import type { SkillFileQueries, SkillQueries, SkillVersionQueries } from '../../public/queries'
import type {
  DeleteSkillFileCatalogInput,
  DiffSkillVersionsCatalogInput,
  GetSkillCatalogInput,
  GetSkillContentCatalogInput,
  GetSkillVersionContentCatalogInput,
  ListSkillFilesCatalogInput,
  ListSkillVersionsCatalogInput,
  ReadSkillFileCatalogInput,
  RestoreSkillVersionCatalogInput,
  SkillCatalogResource,
  WriteSkillFileCatalogInput,
} from '../../public/types'
import type { SkillAccessPort, SkillDeleteConfirmationPort, SkillRepository } from './ports'

export interface SkillApplicationDependencies {
  readonly repository: SkillRepository
  readonly access: SkillAccessPort
  readonly confirmations: SkillDeleteConfirmationPort
}

function jsonOrEmpty(body: string): unknown {
  if (body.trim() === '') return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    return {}
  }
}

function jsonOrInvalid(body: string): unknown {
  if (body.trim() === '') return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

function requirePath(path: string): string {
  if (path.length === 0) {
    throw new ValidationError('path-required', "'path' query parameter is required")
  }
  return path
}

function requireVersion(raw: string, field: string): number {
  const version = Number(raw)
  if (raw === '' || !Number.isInteger(version) || version < 1) {
    throw new ValidationError('skill-version-invalid', `'${field}' must be a positive integer`)
  }
  return version
}

export function createSkillApplication(deps: SkillApplicationDependencies) {
  async function loadVisible(
    authority: SkillOperationContext,
    id: string,
  ): Promise<SkillCatalogResource> {
    const skill = await deps.repository.get(id)
    if (skill === null || !(await deps.access.canView(authority, skill))) {
      throw new NotFoundError('skill-not-found', 'skill not found')
    }
    return skill
  }

  const queries: SkillQueries = Object.freeze({
    async list(authority: SkillOperationContext): Promise<readonly SkillCatalogResource[]> {
      return deps.access.filterVisible(authority, await deps.repository.list())
    },
    async get(
      authority: SkillOperationContext,
      input: GetSkillCatalogInput,
    ): Promise<SkillCatalogResource | null> {
      const skill = await deps.repository.get(input.id)
      if (skill === null || !(await deps.access.canView(authority, skill))) return null
      return skill
    },
    async content(authority: SkillOperationContext, input: GetSkillContentCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      return deps.repository.readContent(skill.id)
    },
  } satisfies SkillQueries)

  const fileQueries: SkillFileQueries = Object.freeze({
    async list(authority: SkillOperationContext, input: ListSkillFilesCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      return deps.repository.listFiles(skill.id)
    },
    async read(authority: SkillOperationContext, input: ReadSkillFileCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      const path = requirePath(input.path)
      return Object.freeze({ path, content: await deps.repository.readFile(skill.id, path) })
    },
  } satisfies SkillFileQueries)

  const versionQueries: SkillVersionQueries = Object.freeze({
    async list(authority: SkillOperationContext, input: ListSkillVersionsCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      return deps.repository.listVersions(skill.id)
    },
    async diff(authority: SkillOperationContext, input: DiffSkillVersionsCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      return deps.repository.diffVersions(
        skill.id,
        requireVersion(input.from, 'from'),
        requireVersion(input.to, 'to'),
      )
    },
    async content(authority: SkillOperationContext, input: GetSkillVersionContentCatalogInput) {
      const skill = await loadVisible(authority, input.id)
      return deps.repository.getVersionContent(skill.id, requireVersion(input.version, 'v'))
    },
  } satisfies SkillVersionQueries)

  const commands = Object.freeze({
    async create(authority: SkillOperationContext, input: CreateSkillCatalogInput) {
      const parsed = CreateManagedSkillSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('skill-invalid', 'invalid skill payload', {
          issues: parsed.error.issues,
        })
      }
      return deps.repository.create(authority, parsed.data)
    },
    async save(authority: SkillOperationContext, input: SaveSkillCatalogInput) {
      const parsed = CombinedSaveSkillSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('skill-content-invalid', 'invalid combined save', {
          issues: parsed.error.issues,
        })
      }
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, current)
      return deps.repository.save(authority, current, parsed.data)
    },
    async delete(
      authority: SkillOperationContext,
      input: DeleteSkillCatalogInput,
    ): Promise<DeleteSkillCatalogReceipt> {
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceGovern(authority, current)
      const body = jsonOrInvalid(input.submission.body)
      deps.confirmations.assertResource(body, current.name)
      const parsed = DeleteSkillSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('skill-delete-invalid', 'invalid skill delete payload', {
          issues: parsed.error.issues,
        })
      }
      await deps.repository.delete(authority, current, parsed.data)
      return Object.freeze({ deleted: current })
    },
  })

  const fileCommands: SkillFileCommands = Object.freeze({
    async write(authority, input: WriteSkillFileCatalogInput) {
      const path = requirePath(input.path)
      const parsed = WriteSkillFileSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('skill-file-invalid', 'invalid file write payload', {
          issues: parsed.error.issues,
        })
      }
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, current)
      return deps.repository.writeFile(authority, current, path, parsed.data)
    },
    async delete(authority, input: DeleteSkillFileCatalogInput) {
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, current)
      const path = requirePath(input.path)
      deps.confirmations.assertFile(jsonOrInvalid(input.submission.body), path, authority.source)
      return deps.repository.deleteFile(authority, current, path, input.expectedToken)
    },
  } satisfies SkillFileCommands)

  const versionCommands: SkillVersionCommands = Object.freeze({
    async restore(authority, input: RestoreSkillVersionCatalogInput) {
      const parsed = RestoreSkillVersionSchema.safeParse(jsonOrEmpty(input.submission.body))
      if (!parsed.success) {
        throw new ValidationError('skill-restore-invalid', 'invalid restore payload', {
          issues: parsed.error.issues,
        })
      }
      const current = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, current)
      return deps.repository.restoreVersion(
        authority,
        current,
        requireVersion(input.version, 'v'),
        parsed.data,
      )
    },
  } satisfies SkillVersionCommands)

  return Object.freeze({
    commands,
    fileCommands,
    versionCommands,
    queries,
    fileQueries,
    versionQueries,
  })
}
