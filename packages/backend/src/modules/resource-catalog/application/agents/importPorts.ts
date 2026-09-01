import type {
  ImportRefCandidate,
  ImportRefSelection,
  ImportRefSelector,
  ImportRefType,
} from '@agent-workflow/shared'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'

export interface AgentImportCandidateSet {
  readonly selector: ImportRefSelector
  readonly candidates: readonly ImportRefCandidate[]
}

export interface AgentImportVisibleSelection {
  readonly type: ImportRefType
  readonly resourceId: string
}

/** One coherent provider snapshot for an Agent portable-import resolution. */
export interface AgentImportResolutionSnapshot {
  readonly candidateSets: readonly AgentImportCandidateSet[]
  readonly visibleSelections: readonly AgentImportVisibleSelection[]
}

export interface AgentImportReferenceReadPort {
  snapshot(
    authority: DirectAuthenticatedAuthority,
    selectors: readonly ImportRefSelector[],
    selections: readonly ImportRefSelection[],
  ): Promise<AgentImportResolutionSnapshot>
}

/** Current-provider transaction reads used by PostgreSQL fence validation. */
export interface TransactionBoundImportReferenceReadPort {
  snapshot(
    authority: DirectAuthenticatedAuthority,
    selectors: readonly ImportRefSelector[],
    selections: readonly ImportRefSelection[],
  ): Promise<AgentImportResolutionSnapshot>
}

/** SQLite-only reads that stay inside the caller's synchronous transaction. */
export interface TransactionBoundImportReferenceSyncReadPort {
  snapshotSync(
    authority: DirectAuthenticatedAuthority,
    selectors: readonly ImportRefSelector[],
    selections: readonly ImportRefSelection[],
  ): AgentImportResolutionSnapshot
}
