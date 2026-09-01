import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createSkillCatalogBootParticipant } from '../application/skills/skillCatalogBootParticipant'
import { createPostgresqlSkillCatalogBootAdapter } from '../infrastructure/postgresqlSkillCatalogBoot'
import { createSqliteSkillCatalogBootAdapter } from '../infrastructure/sqliteSkillCatalogBoot'
import type { SkillCatalogBootParticipant } from '../public/participants'

export function composeSqliteSkillCatalogBoot(input: {
  readonly db: DbClient
  readonly appHome: string
}): SkillCatalogBootParticipant {
  return createSkillCatalogBootParticipant(createSqliteSkillCatalogBootAdapter(input))
}

export function composePostgresqlSkillCatalogBoot(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): SkillCatalogBootParticipant {
  return createSkillCatalogBootParticipant(createPostgresqlSkillCatalogBootAdapter(input))
}
