import type {
  Agent,
  InjectedMemorySnapshot,
  Memory,
  MemoryDistillJob,
  MemoryDistillJobDetail,
  MemoryDistillSessionView,
  MemoryListFilter,
  MemorySummary,
} from '@agent-workflow/shared'
import type {
  AuthenticatedAuthoritySnapshot,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { FusedIntoSkillMemory, MemoryScopeRef, MemoryWithChain } from './types'

export interface MemoryDistillQueries {
  listJobs(filter?: { readonly status?: string }): Promise<MemoryDistillJob[]>
  getJobDetail(jobId: string): Promise<MemoryDistillJobDetail>
  getJobSessionView(jobId: string): Promise<MemoryDistillSessionView>
}

export interface MemoryInjectionBudget {
  readonly agent: number
  readonly workflow: number
  readonly repo: number
  readonly repoGroup: number
  readonly global: number
}

export interface MemoryInjectionQueries {
  injectForRun(input: {
    readonly taskId: string
    readonly primaryAgent: Agent
    readonly dependents: readonly Agent[]
    readonly budget?: MemoryInjectionBudget
    readonly envelopeNonce?: string
  }): Promise<{
    readonly block: string | null
    readonly snapshot: InjectedMemorySnapshot[] | null
  }>
  loadFirstAttemptSnapshot(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
    readonly shardKey: string | null
    readonly reviewIteration: number
    readonly runId: string
  }): Promise<InjectedMemorySnapshot[] | null>
}

// RFC-434: the memory catalog contract, folded in from the former non-exact `public/catalog`.
/**
 * The caller's request authority for catalog visibility checks. RFC-434: a capability, so it lives beside the
 * queries that take it, not in the serializable `public/types` surface.
 */
export interface MemoryScopeAuthority {
  readonly authority: RequestAuthority
  readonly actor: AuthenticatedAuthoritySnapshot
}

export interface MemoryCatalogQueries {
  list(filter?: MemoryListFilter): Promise<MemorySummary[]>
  /**
   * RFC-353 T9 —— 只读投影：这个技能吃进过哪些记忆（按 id 字典序）。
   *
   * 只返回**此刻仍算数**的行（`status='fused'` 且 provenance 指向该技能）——被回滚
   * 退回的记忆不再计入，所以来源面板反映的是当前真相而不是历史流水。
   * 可见性由调用方用 `filterVisible` 过滤，这里不做权限判断。
   */
  listFusedInto(skillId: string): Promise<FusedIntoSkillMemory[]>
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
