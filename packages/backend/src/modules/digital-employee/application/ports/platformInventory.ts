// RFC-561 — Digital Employee's contribution to Intent's platform inventory, declared inside the module. Intent names this
// source with its own type and bootstrap binds the participant to it, so these three types left `public/participants`.
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'

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
 * the reader receives only the three display fields that the dump renders.
 */
export interface DigitalEmployeePlatformInventoryParticipant {
  listVisibleRows(
    type: DigitalEmployeePlatformInventoryResourceType,
    authority: DirectAuthenticatedAuthority,
  ): Promise<readonly DigitalEmployeePlatformInventoryRow[]>
}
