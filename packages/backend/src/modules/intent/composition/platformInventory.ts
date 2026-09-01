import type { Actor } from '@/auth/actor'
import type { DevelopmentConfigOperations } from '@/modules/development-automation/public/operations'
import type { DigitalEmployeePlatformInventoryParticipant } from '@/modules/digital-employee/public/participants'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  IntentPlatformInventoryParticipant,
  IntentPlatformInventoryRow,
} from '../application/ports/intentAuxiliaryQueries'
import type { PlatformOnlyResourceType } from '../domain/teaching/platformMap'

/** Code Capability contributes only its already-authorized public list view. */
export interface IntentCapabilityTemplateInventoryQueries {
  list(authority: DirectAuthenticatedAuthority): Promise<
    readonly Readonly<{
      id: string
      name: string
      description: string | null
    }>[]
  >
}

export interface IntentPlatformInventoryCompositionDependencies {
  readonly authorityFor: (actor: Actor) => DirectAuthenticatedAuthority
  readonly capabilityTemplates: IntentCapabilityTemplateInventoryQueries
  readonly developmentConfig: Pick<DevelopmentConfigOperations, 'resources'>
  readonly digitalEmployee: DigitalEmployeePlatformInventoryParticipant
}

function publishState(publishedRevision: number | null): string {
  return publishedRevision === null ? 'draft' : `published r${publishedRevision}`
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sortRows(
  rows: readonly IntentPlatformInventoryRow[],
): readonly IntentPlatformInventoryRow[] {
  return [...rows].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}

function developmentRows(
  type: Extract<
    PlatformOnlyResourceType,
    | 'digital_employee'
    | 'action_template'
    | 'verification_profile'
    | 'automation_policy'
    | 'development_adapter'
  >,
  rows: Awaited<ReturnType<DevelopmentConfigOperations['resources']['digital-employee']['list']>>,
): readonly IntentPlatformInventoryRow[] {
  return sortRows(
    rows.map((row) => {
      if (type === 'digital_employee') {
        return {
          id: row.id,
          name: row.name,
          description: optionalText(row.description) ?? publishState(row.publishedRevision),
        }
      }
      if (type === 'action_template') {
        const capability = optionalText(row.capabilityId)
        return {
          id: row.id,
          name: row.name,
          description:
            capability === null
              ? publishState(row.publishedRevision)
              : `capability ${capability}; ${publishState(row.publishedRevision)}`,
        }
      }
      if (type === 'development_adapter') {
        return {
          id: row.id,
          name: row.name,
          description: optionalText(row.purpose),
        }
      }
      return {
        id: row.id,
        name: row.name,
        description: publishState(row.publishedRevision),
      }
    }),
  )
}

/**
 * Provider-neutral aggregate for Intent's nine platform-only inventory files.
 * Every contributing query is composed from the same selected provider and is
 * responsible for owner-native visibility filtering before rows cross here.
 */
export function composeIntentPlatformInventoryParticipant(
  input: IntentPlatformInventoryCompositionDependencies,
): IntentPlatformInventoryParticipant {
  return Object.freeze({
    async listRows(type: PlatformOnlyResourceType, actor: Actor) {
      const authority = input.authorityFor(actor)
      if (type === 'capability_template') {
        return sortRows(await input.capabilityTemplates.list(authority))
      }
      if (
        type === 'employee_definition' ||
        type === 'employee_tool' ||
        type === 'employee_job_template'
      ) {
        return sortRows(await input.digitalEmployee.listVisibleRows(type, authority))
      }

      if (type === 'digital_employee') {
        return developmentRows(
          type,
          await input.developmentConfig.resources['digital-employee'].list(authority),
        )
      }
      if (type === 'action_template') {
        return developmentRows(
          type,
          await input.developmentConfig.resources['action-template'].list(authority),
        )
      }
      if (type === 'verification_profile') {
        return developmentRows(
          type,
          await input.developmentConfig.resources['verification-profile'].list(authority),
        )
      }
      if (type === 'automation_policy') {
        return developmentRows(
          type,
          await input.developmentConfig.resources['automation-policy'].list(authority),
        )
      }
      return developmentRows(
        type,
        await input.developmentConfig.resources['development-adapter'].list(authority),
      )
    },
  })
}
