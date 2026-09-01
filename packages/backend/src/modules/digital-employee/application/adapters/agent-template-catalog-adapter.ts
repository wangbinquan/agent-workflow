import type { Agent, CreateAgent } from '@agent-workflow/shared'

import { digitalEmployeeAgentTemplateCatalogParticipantBrand } from '../../domain/participantBrands'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '../../public/participants'

/**
 * Closed persistence supplied by Resource Catalog. It exposes only the four
 * builtin-template operations owned by Digital Employee; no database, row, or
 * generic Agent repository crosses the context boundary.
 */
export interface DigitalEmployeeAgentTemplateCatalogPersistence {
  get(id: string): Promise<Agent | null>
  createBuiltin(id: string, definition: CreateAgent): Promise<void>
  renameBuiltin(id: string, newName: string): Promise<void>
  updateBuiltin(id: string, patch: Omit<CreateAgent, 'name'>): Promise<void>
}

/** Sole mint for the nominal public participant. */
export function createDigitalEmployeeAgentTemplateCatalogParticipant(
  persistence: DigitalEmployeeAgentTemplateCatalogPersistence,
): DigitalEmployeeAgentTemplateCatalogParticipant {
  return Object.freeze({
    [digitalEmployeeAgentTemplateCatalogParticipantBrand]:
      'digital-employee-agent-template-catalog-participant' as const,
    get: (id: string) => persistence.get(id),
    createBuiltin: (id: string, definition: CreateAgent) =>
      persistence.createBuiltin(id, definition),
    renameBuiltin: (id: string, newName: string) => persistence.renameBuiltin(id, newName),
    updateBuiltin: (id: string, patch: Omit<CreateAgent, 'name'>) =>
      persistence.updateBuiltin(id, patch),
  })
}
