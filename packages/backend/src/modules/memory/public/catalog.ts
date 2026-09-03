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
  /**
   * RFC-352 T8 —— 分页列表。**只有传了分页参数的调用者走这条路**；不传的仍走 `list`，
   * wire 逐字节不变。
   *
   * 三层查询后过滤（标签 / scope 可见性 / 候选收窄）都在实现里按 keyset 迭代累积，
   * 因此返回的一页**可能不满 `limit` 却仍带 `nextCursor`**——判到底只看 `nextCursor === null`。
   * `includeCandidates` 由调用方按 `resource-acl:bypass` 传入（RFC-285 Q4）。
   */
  listPage(
    authority: MemoryScopeAuthority,
    filter: MemoryListFilter,
    page: { readonly cursor: string | null; readonly limit: number },
    options: { readonly includeCandidates: boolean },
  ): Promise<{
    readonly items: Array<MemorySummary & { readonly canManage: boolean }>
    readonly nextCursor: string | null
  }>
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
