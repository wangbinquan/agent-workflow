import {
  createDigitalEmployeeAgentTemplateCatalogParticipant,
  type DigitalEmployeeAgentTemplateCatalogPersistence,
} from '../application/adapters/agent-template-catalog-adapter'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '../public/participants'

export type { DigitalEmployeeAgentTemplateCatalogPersistence }

/**
 * Composition boundary consumed by Resource Catalog's SQLite/PostgreSQL
 * persistence factories. Only this owner factory can mint the branded public
 * participant.
 */
export function composeDigitalEmployeeAgentTemplateCatalogParticipant(
  persistence: DigitalEmployeeAgentTemplateCatalogPersistence,
): DigitalEmployeeAgentTemplateCatalogParticipant {
  return createDigitalEmployeeAgentTemplateCatalogParticipant(persistence)
}
