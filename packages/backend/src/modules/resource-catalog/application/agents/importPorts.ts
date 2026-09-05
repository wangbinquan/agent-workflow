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

/** 绑定到调用方已开事务的读面：终写围栏与写入同一快照（RFC-359 W4-D14 起两个 provider 同一份）。 */
export interface TransactionBoundImportReferenceReadPort {
  snapshot(
    authority: DirectAuthenticatedAuthority,
    selectors: readonly ImportRefSelector[],
    selections: readonly ImportRefSelection[],
  ): Promise<AgentImportResolutionSnapshot>
}
