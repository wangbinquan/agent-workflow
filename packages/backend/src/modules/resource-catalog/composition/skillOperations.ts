import type { Skill } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { assertDeleteConfirm, assertTokenDeleteConfirm } from '@/services/deleteConfirm'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { createSkillApplication } from '../application/skills/skillApplication'
import type { SkillAccessPort, SkillDeleteConfirmationPort } from '../application/skills/ports'
import { createSqliteSkillRepository } from '../infrastructure/sqliteSkillRepository'
import { createSkillOperationDescriptors, type SkillCatalogModule } from '../public/operations'
import type { SkillOperationContext } from '../public/participants'

export interface SkillCatalogCompositionDependencies {
  readonly db: DbClient
  readonly appHome: string
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
  const application = createSkillApplication({ repository, access, confirmations })
  const acl = composeResourceAclOperationApplication<SkillOperationContext, Skill>({
    db: input.db,
    type: 'skill',
    load: (id) => repository.get(id),
  })
  const operations = createSkillOperationDescriptors(
    application.commands,
    application.queries,
    application.fileCommands,
    application.fileQueries,
    application.versionCommands,
    application.versionQueries,
    acl,
  )
  return Object.freeze({
    fileCommands: application.fileCommands,
    versionCommands: application.versionCommands,
    queries: application.queries,
    fileQueries: application.fileQueries,
    versionQueries: application.versionQueries,
    operations,
  })
}
