// RFC-517 — the Digital Employee owner adapter for Intent's platform inventory (RFC-294 S10): the selected module's
// queries supply the rows, the Resource Catalog authorization face filters them, and the projection is ordered by
// name and id.
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  DigitalEmployeePlatformInventoryParticipant,
  DigitalEmployeePlatformInventoryResourceType,
  DigitalEmployeePlatformInventoryRow,
} from '../public/participants'
import type { DigitalEmployeeQueries, ToolRegistrationView } from './ports/digitalEmployeeModule'

interface DigitalEmployeePlatformInventoryAclRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

/** Selected-provider Resource Catalog authorization face used by this owner adapter. */
export interface DigitalEmployeePlatformInventoryAccess {
  filterVisibleRows<T extends DigitalEmployeePlatformInventoryAclRow>(
    authority: DirectAuthenticatedAuthority,
    type: DigitalEmployeePlatformInventoryResourceType,
    rows: readonly T[],
  ): Promise<T[]>
}

function inventoryText(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['en', 'en-US', 'zh', 'zh-CN', ...Object.keys(record)]) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function sortInventoryRows(
  rows: readonly DigitalEmployeePlatformInventoryRow[],
): DigitalEmployeePlatformInventoryRow[] {
  return [...rows].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}

/**
 * Owner adapter for Intent's three Digital Employee inventory kinds. The
 * selected SQLite/PostgreSQL module supplies the rows and the selected
 * Resource Catalog authorization application filters them before projection.
 */
export function composeDigitalEmployeePlatformInventoryParticipant(input: {
  readonly queries: Pick<
    DigitalEmployeeQueries,
    'listTypes' | 'listTools' | 'listJobTemplates' | 'listEmployees'
  >
  readonly access: DigitalEmployeePlatformInventoryAccess
}): DigitalEmployeePlatformInventoryParticipant {
  const visible = async <T extends DigitalEmployeePlatformInventoryAclRow>(
    type: DigitalEmployeePlatformInventoryResourceType,
    authority: DirectAuthenticatedAuthority,
    rows: readonly T[],
    project: (row: T) => DigitalEmployeePlatformInventoryRow,
  ): Promise<readonly DigitalEmployeePlatformInventoryRow[]> =>
    sortInventoryRows((await input.access.filterVisibleRows(authority, type, rows)).map(project))

  return Object.freeze({
    async listVisibleRows(
      type: DigitalEmployeePlatformInventoryResourceType,
      authority: DirectAuthenticatedAuthority,
    ) {
      if (type === 'employee_definition') {
        return await visible(type, authority, await input.queries.listEmployees(), (row) => {
          return {
            id: row.id,
            name: row.name,
            description: `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
          }
        })
      }

      const packages = await input.queries.listTypes()
      if (type === 'employee_job_template') {
        const rows = (
          await Promise.all(packages.map((item) => input.queries.listJobTemplates(item.typeRef)))
        ).flat()
        return await visible(type, authority, rows, (row) => {
          return {
            id: row.id,
            name: row.name,
            description:
              inventoryText(row.draft.description) ??
              `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
          }
        })
      }

      const rows = new Map<string, ToolRegistrationView>()
      await Promise.all(
        packages.flatMap((item) =>
          item.authoringManifest.workItems.map(async (workItem) => {
            for (const tool of await input.queries.listTools(item.typeRef, workItem.workItemRef)) {
              rows.set(tool.id, tool)
            }
          }),
        ),
      )
      return await visible(type, authority, [...rows.values()], (row) => {
        return {
          id: row.id,
          name: inventoryText(row.content.displayName) ?? row.id,
          description: `${inventoryText(row.content.description) ?? (row.origin === 'platform' ? 'platform tool' : 'custom tool')} (${row.workItemRef})`,
        }
      })
    },
  })
}
