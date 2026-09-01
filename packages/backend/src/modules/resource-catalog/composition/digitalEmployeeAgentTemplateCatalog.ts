import type { DbClient } from '@/db/client'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createDigitalEmployeeAgentTemplateCatalogPersistence,
  type DigitalEmployeeAgentTemplateCatalogPersistencePort,
} from '../application/agents/digitalEmployeeAgentTemplateCatalog'
import { createPostgresqlDigitalEmployeeAgentTemplateRepository } from '../infrastructure/postgresqlDigitalEmployeeAgentTemplateCatalog'
import { createSqliteDigitalEmployeeAgentTemplateRepository } from '../infrastructure/sqliteDigitalEmployeeAgentTemplateCatalog'

/**
 * Digital Employee owns the runtime brand and is therefore the only context
 * allowed to mint this participant. The outer composition root injects that
 * exact mint while Resource Catalog supplies only its closed persistence port.
 */
export type DigitalEmployeeAgentTemplateCatalogParticipantMint = (
  persistence: DigitalEmployeeAgentTemplateCatalogPersistencePort,
) => DigitalEmployeeAgentTemplateCatalogParticipant

export function composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(
  db: DbClient,
  mint: DigitalEmployeeAgentTemplateCatalogParticipantMint,
): DigitalEmployeeAgentTemplateCatalogParticipant {
  return mint(
    createDigitalEmployeeAgentTemplateCatalogPersistence(
      createSqliteDigitalEmployeeAgentTemplateRepository(db),
    ),
  )
}

export function composePostgresqlDigitalEmployeeAgentTemplateCatalogParticipant(
  db: PostgresqlDatabaseClient,
  mint: DigitalEmployeeAgentTemplateCatalogParticipantMint,
): DigitalEmployeeAgentTemplateCatalogParticipant {
  return mint(
    createDigitalEmployeeAgentTemplateCatalogPersistence(
      createPostgresqlDigitalEmployeeAgentTemplateRepository(db),
    ),
  )
}
