import type { Skill } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { assertDeleteConfirm, assertTokenDeleteConfirm } from '@/services/deleteConfirm'
import {
  canViewResource,
  composeProviderResourceAclOperationApplication,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { createSkillApplication } from '../application/skills/skillApplication'
import type {
  SkillAccessPort,
  SkillDeleteConfirmationPort,
  SkillRepository,
} from '../application/skills/ports'
import { createSqliteSkillRepository } from '../infrastructure/sqliteSkillRepository'
import { createSqliteSkillZipImportParticipant } from '../infrastructure/sqliteSkillZipImport'
import { createPostgresqlSkillZipImportParticipant } from '../infrastructure/postgresqlSkillZipImport'
import {
  createPostgresqlSkillRepository,
  type PostgresqlSkillContentLifecycle,
} from '../infrastructure/postgresqlSkillRepository'
import { createSkillOperationDescriptors } from './catalogOperationDescriptors'
import type { SkillCatalogModule } from '../public/operations'
import type { SkillOperationContext } from '../public/participants'
import type { SkillZipImportParticipant } from '../public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export interface SkillCatalogCompositionDependencies {
  readonly db: DbClient
  readonly appHome: string
}

type SkillAclOperationApplication = Parameters<typeof createSkillOperationDescriptors>[6]

export interface SkillCatalogAdapterCompositionDependencies {
  readonly repository: SkillRepository
  readonly access: SkillAccessPort
  readonly confirmations: SkillDeleteConfirmationPort
  readonly acl: SkillAclOperationApplication
  readonly zipImport: SkillZipImportParticipant
}

export interface PostgresqlSkillCatalogCompositionDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

export function composeSkillCatalogFromAdapters(
  input: SkillCatalogAdapterCompositionDependencies,
): SkillCatalogModule {
  const application = createSkillApplication({
    repository: input.repository,
    access: input.access,
    confirmations: input.confirmations,
  })
  const operations = createSkillOperationDescriptors(
    application.commands,
    application.queries,
    application.fileCommands,
    application.fileQueries,
    application.versionCommands,
    application.versionQueries,
    input.acl,
  )
  return Object.freeze({
    fileCommands: application.fileCommands,
    versionCommands: application.versionCommands,
    queries: application.queries,
    fileQueries: application.fileQueries,
    versionQueries: application.versionQueries,
    zipImport: input.zipImport,
    operations,
  })
}

export function composePostgresqlSkillCatalog(
  input: PostgresqlSkillCatalogCompositionDependencies,
): SkillCatalogModule {
  const repository = createPostgresqlSkillRepository({ db: input.db, content: input.content })
  const access = Object.freeze({
    filterVisible: (authority: SkillOperationContext, rows: readonly Skill[]) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'skill', rows),
    canView: (authority: SkillOperationContext, row: Skill) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'skill', row),
    requireResourceEdit: async (authority: SkillOperationContext, row: Skill) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'skill', row)
    },
    requireResourceGovern: (authority: SkillOperationContext, row: Skill) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'skill', row),
  } satisfies SkillAccessPort)
  const confirmations = Object.freeze({
    assertResource: (body: unknown, expectedName: string) =>
      assertDeleteConfirm(body, expectedName, 'skill'),
    assertFile: (body: unknown, expectedPath: string, source: SkillOperationContext['source']) =>
      assertTokenDeleteConfirm(body, expectedPath, 'skill file', source),
  } satisfies SkillDeleteConfirmationPort)
  const acl = composeProviderResourceAclOperationApplication<SkillOperationContext, 'skill', Skill>(
    {
      ...input.resourceCatalog,
      type: 'skill',
      load: (id) => repository.get(id),
    },
  )
  return composeSkillCatalogFromAdapters({
    repository,
    access,
    confirmations,
    acl,
    zipImport: createPostgresqlSkillZipImportParticipant({
      db: input.db,
      content: input.content,
    }),
  })
}

export function composeSkillCatalog(
  input: SkillCatalogCompositionDependencies,
): SkillCatalogModule {
  const repository = createSqliteSkillRepository(input.db, { appHome: input.appHome })
  const access: SkillAccessPort = Object.freeze({
    filterVisible: (authority: SkillOperationContext, rows: readonly Skill[]) =>
      filterVisibleRows(input.db, authority, 'skill', [...rows]),
    canView: (authority: SkillOperationContext, row: Skill) =>
      canViewResource(input.db, authority, 'skill', row),
    requireResourceEdit: async (authority: SkillOperationContext, row: Skill) => {
      await requireResourceEdit(input.db, authority, 'skill', row)
    },
    requireResourceGovern: (authority: SkillOperationContext, row: Skill) =>
      requireResourceGovern(input.db, authority, 'skill', row),
  })
  const confirmations: SkillDeleteConfirmationPort = Object.freeze({
    assertResource: (body, expectedName) => assertDeleteConfirm(body, expectedName, 'skill'),
    assertFile: (body, expectedPath, source) =>
      assertTokenDeleteConfirm(body, expectedPath, 'skill file', source),
  } satisfies SkillDeleteConfirmationPort)
  const acl = composeResourceAclOperationApplication<SkillOperationContext, Skill>({
    db: input.db,
    type: 'skill',
    load: (id) => repository.get(id),
  })
  return composeSkillCatalogFromAdapters({
    repository,
    access,
    confirmations,
    acl,
    zipImport: createSqliteSkillZipImportParticipant({
      db: input.db,
      appHome: input.appHome,
    }),
  })
}
