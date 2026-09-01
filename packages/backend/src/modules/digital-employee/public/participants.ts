import type { Agent, CreateAgent } from '@agent-workflow/shared'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { digitalEmployeeAgentTemplateCatalogParticipantBrand } from '../domain/participantBrands'

declare const digitalEmployeeIntegrationTriggerParticipantBrand: unique symbol

export type DigitalEmployeePlatformInventoryResourceType =
  | 'employee_definition'
  | 'employee_tool'
  | 'employee_job_template'

export interface DigitalEmployeePlatformInventoryRow {
  readonly id: string
  readonly name: string
  readonly description: string | null
}

/**
 * Visibility-filtered Digital Employee contribution to Intent's read-only
 * platform inventory. The owner keeps authoring rows and ACL facts private;
 * consumers receive only the three display fields that the dump renders.
 */
export interface DigitalEmployeePlatformInventoryParticipant {
  listVisibleRows(
    type: DigitalEmployeePlatformInventoryResourceType,
    authority: DirectAuthenticatedAuthority,
  ): Promise<readonly DigitalEmployeePlatformInventoryRow[]>
}

/**
 * Resource Catalog owns Agent persistence; Digital Employee owns the exact
 * builtin-template convergence use case. Bootstrap binds this closed catalog
 * participant from the selected Resource Catalog provider.
 */
export interface DigitalEmployeeAgentTemplateCatalogParticipant {
  readonly [digitalEmployeeAgentTemplateCatalogParticipantBrand]: 'digital-employee-agent-template-catalog-participant'
  get(id: string): Promise<Agent | null>
  createBuiltin(id: string, definition: CreateAgent): Promise<void>
  renameBuiltin(id: string, newName: string): Promise<void>
  updateBuiltin(id: string, patch: Omit<CreateAgent, 'name'>): Promise<void>
}

export interface DigitalEmployeeIntegrationTriggerIdentity {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly archivedAt: number | null
  readonly currentRevision: number | null
  readonly typeId: string
  readonly typeRevision: number
}

export type DigitalEmployeeIntegrationTriggerSnapshot =
  | Readonly<{ readonly kind: 'revision-unavailable' }>
  | Readonly<{ readonly kind: 'intake-unavailable' }>
  | Readonly<{
      readonly kind: 'ready'
      readonly employeeDefinitionId: string
      readonly currentRevision: number
      readonly typeId: string
      readonly typeRevision: number
      readonly intake: Readonly<{
        readonly acceptedKinds: readonly ('body' | 'files' | 'body-and-files' | 'external-id')[]
        readonly targetFields: readonly Readonly<{
          readonly fieldRef: string
          readonly required: boolean
        }>[]
      }>
    }>

/**
 * Owner-native read participant used by the resource-catalog integration-trigger adapter.
 *
 * Identity is loaded separately from content so the consumer can preserve the
 * ACL-before-content invariant. The handle is minted only by the Digital
 * Employee application factory and carries no database-shaped values.
 */
export interface DigitalEmployeeIntegrationTriggerParticipant {
  readonly [digitalEmployeeIntegrationTriggerParticipantBrand]: 'digital-employee-integration-trigger-participant'

  loadIdentity(
    employeeDefinitionId: string,
  ): Promise<DigitalEmployeeIntegrationTriggerIdentity | null>

  loadCurrentSnapshot(
    employeeDefinitionId: string,
  ): Promise<DigitalEmployeeIntegrationTriggerSnapshot>
}
