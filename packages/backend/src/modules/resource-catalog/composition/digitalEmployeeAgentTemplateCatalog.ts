import type { ProviderNeutralDatabase } from '@/db/query'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import {
  createDigitalEmployeeAgentTemplateCatalogPersistence,
  type DigitalEmployeeAgentTemplateCatalogPersistencePort,
} from '../application/agents/digitalEmployeeAgentTemplateCatalog'
import { createDigitalEmployeeAgentTemplateRepository } from '../infrastructure/digitalEmployeeAgentTemplateCatalog'

/**
 * Digital Employee owns the runtime brand and is therefore the only context
 * allowed to mint this participant. The outer composition root injects that
 * exact mint while Resource Catalog supplies only its closed persistence port.
 */
export type DigitalEmployeeAgentTemplateCatalogParticipantMint = (
  persistence: DigitalEmployeeAgentTemplateCatalogPersistencePort,
) => DigitalEmployeeAgentTemplateCatalogParticipant

/** RFC-359 W4-D22 —— 岗位模版目录一份装配，两个 provider 共用。 */
export function composeDigitalEmployeeAgentTemplateCatalogFor(
  db: ProviderNeutralDatabase,
  mint: DigitalEmployeeAgentTemplateCatalogParticipantMint,
): DigitalEmployeeAgentTemplateCatalogParticipant {
  return mint(
    createDigitalEmployeeAgentTemplateCatalogPersistence(
      createDigitalEmployeeAgentTemplateRepository(db),
    ),
  )
}
