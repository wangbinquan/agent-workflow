import type { Skill } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { assertDeleteConfirm, assertTokenDeleteConfirm } from '@/services/deleteConfirm'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { createSkillApplication } from '../application/skills/skillApplication'
import type {
  SkillAccessPort,
  SkillDeleteConfirmationPort,
  SkillRepository,
} from '../application/skills/ports'
import type { SkillRestoreMembershipPort } from '../infrastructure/legacy/skillVersion'
import { createSkillRepository } from '../infrastructure/skillRepository'
import { createSkillZipImportParticipant } from '../infrastructure/skillZipImportAdapter'
import { createSkillOperationDescriptors } from './catalogOperationDescriptors'
import type { SkillCatalogModule } from '../public/operations'
import type { SkillOperationContext } from '../public/participants'
import type { SkillZipImportParticipant } from '../public/participants'

export interface SkillCatalogCompositionDependencies {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  /**
   * RFC-353 T7：回滚时「哪些记忆退回待用」由 knowledge-evolution 的协调器裁定。
   * 由 bootstrap 交进来——RFC-294 的目标边表里没有 `resource-catalog → knowledge-evolution`，
   * resource-catalog 不能自己去取。
   */
  readonly restoreMembership: SkillRestoreMembershipPort
}

type SkillAclOperationApplication = Parameters<typeof createSkillOperationDescriptors>[6]

export interface SkillCatalogAdapterCompositionDependencies {
  readonly repository: SkillRepository
  readonly access: SkillAccessPort
  readonly confirmations: SkillDeleteConfirmationPort
  readonly acl: SkillAclOperationApplication
  readonly zipImport: SkillZipImportParticipant
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

/**
 * RFC-359 W4-D23c —— 技能目录：一份装配，两个数据库共用。
 *
 * 此前 SQLite 走 173 行薄适配器套成熟的崩溃安全机器，PostgreSQL 走 3342 行原生重写，
 * 归一化相似度 7%、行为覆盖 52:6 倒挂。D23a 的双引擎一致性套件按端口取证后，
 * D23b 把机器本身迁到中立事务原语，这里收口：原生重写整体退役。
 */
export function composeSkillCatalog(
  input: SkillCatalogCompositionDependencies,
): SkillCatalogModule {
  const repository = createSkillRepository(
    input.db,
    { appHome: input.appHome },
    input.restoreMembership,
  )
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
    zipImport: createSkillZipImportParticipant({
      db: input.db,
      appHome: input.appHome,
    }),
  })
}
