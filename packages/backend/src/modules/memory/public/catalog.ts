import type {
  Memory,
  MemoryCandidatePromote,
  MemoryCreateRequest,
  MemoryListFilter,
  MemoryMoveRequest,
  MemoryPatchField,
  MemoryPatchRequest,
  MemorySummary,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type {
  CommandContext,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'

export interface MemoryWithChain {
  readonly memory: Memory
  readonly ancestors: Memory[]
}

export interface PatchMemoryResult {
  readonly memory: Memory
  readonly changedFields: ReadonlyArray<MemoryPatchField>
}

export interface MoveMemoryResult {
  readonly memory: Memory
  readonly moved: boolean
}

export interface MemoryScopeRef {
  readonly scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  readonly scopeId: string | null
}

export interface MemoryScopeAuthority {
  readonly authority: RequestAuthority
  readonly actor: Actor
}

export interface MemoryCatalogQueries {
  list(filter?: MemoryListFilter): Promise<MemorySummary[]>
  listWithBody(filter?: MemoryListFilter): Promise<Memory[]>
  getById(id: string): Promise<MemoryWithChain | null>
  canView(authority: MemoryScopeAuthority, scope: MemoryScopeRef): Promise<boolean>
  canManage(authority: MemoryScopeAuthority, scope: MemoryScopeRef): Promise<boolean>
  filterVisible<T extends MemoryScopeRef>(
    authority: MemoryScopeAuthority,
    rows: readonly T[],
  ): Promise<T[]>
  annotateManageRights<T extends MemoryScopeRef>(
    authority: MemoryScopeAuthority,
    rows: readonly T[],
  ): Promise<Array<T & { readonly canManage: boolean }>>
}

export interface MemoryCatalogCommands {
  createManual(input: MemoryCreateRequest): Promise<Memory>
  promote(id: string, input: MemoryCandidatePromote, administratorUserId: string): Promise<Memory>
  patch(id: string, input: MemoryPatchRequest, editorUserId?: string): Promise<PatchMemoryResult>
  move(context: CommandContext, id: string, input: MemoryMoveRequest): Promise<MoveMemoryResult>
  archive(id: string): Promise<Memory>
  unarchive(id: string): Promise<Memory>
  delete(id: string): Promise<void>
}

export interface MemoryCatalogOperations {
  readonly queries: MemoryCatalogQueries
  readonly commands: MemoryCatalogCommands
}
