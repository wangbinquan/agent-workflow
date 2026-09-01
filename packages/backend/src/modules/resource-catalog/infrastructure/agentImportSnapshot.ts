import type {
  ImportRefCandidate,
  ImportRefSelection,
  ImportRefSelector,
  ImportRefType,
  ResourceVisibility,
} from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  AgentImportCandidateSet,
  AgentImportResolutionSnapshot,
} from '../application/agents/importPorts'
import { isVisibleRow } from '../domain/resourceAccess'

export interface AgentImportIdentityRow {
  readonly type: ImportRefType
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

export function projectAgentImportResolutionSnapshot(input: {
  readonly authority: DirectAuthenticatedAuthority
  readonly selectors: readonly ImportRefSelector[]
  readonly selections: readonly ImportRefSelection[]
  readonly rows: readonly AgentImportIdentityRow[]
  readonly grantedIdsByType: ReadonlyMap<ImportRefType, ReadonlySet<string>>
  readonly usernamesById: ReadonlyMap<string, string>
}): AgentImportResolutionSnapshot {
  const visibleRows = input.rows.filter((row) =>
    isVisibleRow(input.authority, row, input.grantedIdsByType.get(row.type) ?? new Set()),
  )
  const candidateSets: AgentImportCandidateSet[] = input.selectors.map((selector) => {
    const candidates = visibleRows
      .filter(
        (row) =>
          row.type === selector.type &&
          row.name === selector.name &&
          (selector.ownerUsername === undefined ||
            (row.ownerUserId !== null &&
              (row.ownerUserId === SYSTEM_USER_ID
                ? SYSTEM_USER_ID
                : input.usernamesById.get(row.ownerUserId)) === selector.ownerUsername)),
      )
      .map(
        (row): ImportRefCandidate =>
          Object.freeze({
            id: row.id,
            ownerUserId: row.ownerUserId,
            ownerUsername:
              row.ownerUserId === null
                ? null
                : row.ownerUserId === SYSTEM_USER_ID
                  ? SYSTEM_USER_ID
                  : (input.usernamesById.get(row.ownerUserId) ?? null),
            visibility: row.visibility,
            aclRevision: row.aclRevision,
          }),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    return Object.freeze({ selector, candidates: Object.freeze(candidates) })
  })
  const visibleSelections = input.selections.flatMap((selection) =>
    visibleRows.some(
      (row) => row.type === selection.selector.type && row.id === selection.resourceId,
    )
      ? [Object.freeze({ type: selection.selector.type, resourceId: selection.resourceId })]
      : [],
  )
  return Object.freeze({
    candidateSets: Object.freeze(candidateSets),
    visibleSelections: Object.freeze(visibleSelections),
  })
}
