// RFC-561 — the two cross-context sources of Intent's platform inventory, declared with this module's own types. Bootstrap
// hands over Development Automation's configuration operations and Digital Employee's inventory participant (the same
// objects as before), so Intent names neither context.
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { PlatformOnlyResourceType } from '../../domain/teaching/platformMap'
import type { IntentPlatformInventoryRow } from './intentAuxiliaryQueries'

/**
 * One development configuration row as its owner lists it. Intent reads the identity, the published revision and three
 * display fields the owner may carry; whatever else the row holds stays unread.
 */
export interface IntentDevelopmentConfigInventoryRow {
  readonly id: string
  readonly name: string
  readonly publishedRevision: number | null
  readonly description?: unknown
  readonly capabilityId?: unknown
  readonly purpose?: unknown
}

/** Development Automation contributes its already-authorized list of each configuration kind. */
export interface IntentDevelopmentConfigInventoryQueries {
  readonly resources: Readonly<
    Record<
      | 'digital-employee'
      | 'action-template'
      | 'verification-profile'
      | 'automation-policy'
      | 'development-adapter',
      {
        list(
          authority: DirectAuthenticatedAuthority,
        ): Promise<readonly IntentDevelopmentConfigInventoryRow[]>
      }
    >
  >
}

/** Digital Employee contributes its visibility-filtered display rows for its three inventory kinds. */
export interface IntentDigitalEmployeeInventoryQueries {
  listVisibleRows(
    type: Extract<
      PlatformOnlyResourceType,
      'employee_definition' | 'employee_tool' | 'employee_job_template'
    >,
    authority: DirectAuthenticatedAuthority,
  ): Promise<readonly IntentPlatformInventoryRow[]>
}
