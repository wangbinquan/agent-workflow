// RFC-348 D3 — pure rendering boundary for platform-only Intent inventory.
//
// Each owning bounded context supplies its visible rows through the closed
// `IntentPlatformInventoryParticipant` contract composed at bootstrap. Intent
// deliberately has no default loader: reaching into nine SQLite stores here
// would select a persistence provider inside the consumer and would bypass the
// owners' public authorization projections.

import {
  platformOnlyResourceTypes,
  type PlatformOnlyResourceType,
} from '@/modules/intent/domain/teaching/platformMap'
import type {
  IntentPlatformInventoryParticipant,
  IntentPlatformInventoryRow,
} from '@/modules/intent/public/operations'

export type PlatformInventoryRow = IntentPlatformInventoryRow
export type IntentPlatformInventory = IntentPlatformInventoryParticipant

export const PLATFORM_INVENTORY_ROW_CAP = 200

/** One `inventory/platform/<type>.md`: capped read-only rows without handles. */
export function renderPlatformInventoryFile(
  type: PlatformOnlyResourceType,
  rows: readonly PlatformInventoryRow[],
  cap: number = PLATFORM_INVENTORY_ROW_CAP,
): string {
  const kept = rows.slice(0, cap)
  const dropped = rows.length - kept.length
  const lines = [
    `# ${type} (${rows.length} visible; read-only — cannot be referenced${dropped > 0 ? `; TRUNCATED — ${dropped} more not listed` : ''})`,
    '',
    'Not creatable, updatable, mountable or referenceable from a changeset — no handles. Listed so you can recognise what already exists and tell the user where it is managed (see "Platform capability map" in INTENT.md).',
    '',
    ...kept.map(
      (row) =>
        `- \`${row.name}\`${row.description === null || row.description === '' ? '' : ` — ${row.description.split('\n', 1)[0]}`}`,
    ),
  ]
  return `${lines.join('\n')}\n`
}

/** Roster order, for callers that write one file per type. */
export function platformInventoryTypes(): readonly PlatformOnlyResourceType[] {
  return platformOnlyResourceTypes()
}
