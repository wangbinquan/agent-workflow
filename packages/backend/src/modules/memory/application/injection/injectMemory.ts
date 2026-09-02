// RFC-352（RFC-294 W4-E2）—— 运行时记忆注入的**编排**面，从 `services/memoryInject.ts`
// 平移到 memory 的 application 层。取数经 `MemoryInjectionReadStore` 端口，渲染调用
// domain 的纯函数（`../../domain/injectionRendering`）。
//
// RFC-294 `design.md`：注入选择器只作为 task-owned `TaskMemoryInjectionPort` 的实现存在，
// 不从 memory public query 暴露正文。RFC-041 的 live-read 语义保持不变——每次 runNode
// 重新取当前 approved 的行，中途新批准的记忆下一次 runNode 即生效。

import type { Agent, InjectedMemorySnapshot } from '@agent-workflow/shared'
import type { MemoryInjectionReadStore, MemoryInjectionRecord } from '../ports/injectionReadStore'
import {
  DEFAULT_INJECTION_BUDGET,
  formatMemoryBlockWithSnapshot,
  memoryFencingForNonce,
  parseInjectedSnapshotJson,
  type InjectableMemoryRow,
  type InjectableMemorySet,
  type ScopeBudget,
} from '../../domain/injectionRendering'

export interface LoadInjectableMemoriesOptions {
  /**
   * The primary agent's id plus every agent in its dependsOn closure. The
   * runner passes `[opts.agent.id, ...opts.dependents.map((d) => d.id)]`
   * so memories scoped to *any* closure member surface to the running
   * agent (mirrors how skills / mcp / plugins propagate via dependsOn).
   */
  agentIds: readonly string[]
  /** task.workflowId — null skips the workflow scope. */
  workflowId: string | null
  /**
   * RFC-248: 本任务涉及的**全部** cached_repo.id（去重）。RFC-041 时代这里是
   * 单数 `repoId`——一个任务只有一个仓。仓库组启动后一个任务有 N 个成员仓，
   * 每个仓自己的 repo 记忆都该注入（D4），所以改成复数。空数组 = 跳过 repo 档。
   *
   * 查表是调用方的责任：runner 手上已经有 task 行与 task_repos 行，不值得为此
   * 在每次注入时再 SELECT 一遍。
   */
  repoIds: readonly string[]
  /**
   * RFC-248 D4: 用仓库组启动时的组 id；null = 单仓 / scratch 启动。
   *
   * 单仓直启**不**注入它所属任何组的记忆——组记忆是关于「这个组合怎么一起
   * 干活」的知识，单独跑一个仓时无意义，且一个仓可能属于很多组，全注入会爆。
   */
  repoGroupId: string | null
}

/**
 * Load every approved memory that should be injected into the current
 * agent run. Each scope is queried independently to stay clear of OR-tree
 * inefficiencies on the composite (scope_type, scope_id, status) index
 * the migration declares.
 *
 * Returns rows ordered by `createdAt DESC` per scope — runner clips with
 * `formatMemoryBlock(...)`, which trims oldest entries first when over
 * budget. Superseded / archived / candidate / rejected rows are excluded
 * by the WHERE clause.
 */
export async function loadInjectableMemories(
  store: MemoryInjectionReadStore,
  opts: LoadInjectableMemoriesOptions,
): Promise<InjectableMemorySet> {
  const out: InjectableMemorySet = {
    byScope: { agent: [], workflow: [], repo: [], repoGroup: [], global: [] },
  }

  // Agent scope — closure-aware: every closure member's memories surface
  // to the primary. Dedupe by row id (a memory belongs to exactly one
  // scope_id, so duplicates would only arise if the same id leaked into
  // the agentIds set twice — defensive guard).
  const uniqueAgentIds = [...new Set(opts.agentIds)].filter((id) => id.length > 0)
  if (uniqueAgentIds.length > 0) {
    const rows = await store.listApprovedMemories({
      scopeType: 'agent',
      scopeIds: uniqueAgentIds,
    })
    const seen = new Set<string>()
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.byScope.agent.push(rowToInjectable(r))
    }
  }

  if (opts.workflowId !== null) {
    const rows = await store.listApprovedMemories({
      scopeType: 'workflow',
      scopeIds: [opts.workflowId],
    })
    out.byScope.workflow = rows.map(rowToInjectable)
  }

  if (opts.repoIds.length > 0) {
    // RFC-248: 组内 N 个成员仓的 repo 记忆共用 `budget.repo` 一档，按
    // createdAt DESC 统一排序后裁剪——不给每个仓单独配额，否则成员一多
    // 整块就撑爆了。
    const rows = await store.listApprovedMemories({
      scopeType: 'repo',
      scopeIds: opts.repoIds,
    })
    out.byScope.repo = rows.map(rowToInjectable)
  }

  if (opts.repoGroupId !== null) {
    const rows = await store.listApprovedMemories({
      scopeType: 'repo_group',
      scopeIds: [opts.repoGroupId],
    })
    out.byScope.repoGroup = rows.map(rowToInjectable)
  }

  const globalRows = await store.listApprovedMemories({
    scopeType: 'global',
    scopeIds: null,
  })
  out.byScope.global = globalRows.map(rowToInjectable)

  return out
}

function rowToInjectable(row: MemoryInjectionRecord): InjectableMemoryRow {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
    version: row.version,
    tags: parseTagsField(row.tagsJson),
    sourceKind: row.sourceKind,
    approvedAt: row.approvedAt,
  }
}

/**
 * RFC-046: tolerant parse for memories.tags (text JSON column). A malformed
 * row must never crash inject — degrade to [] rather than 5xx the user's
 * task.
 */
function parseTagsField(raw: string | null | undefined): string[] {
  if (raw == null) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    return []
  }
}

/**
 * Convenience top-level orchestrator for runner.ts. One call resolves the
 * task's workflow / repo / agent-closure scope ids, loads the matching
 * approved memories, applies the per-scope budget, and renders the block.
 * Returns `null` when there is nothing to inject — the runner then
 * leaves the inline agent prompt untouched, byte-for-byte identical to
 * the pre-RFC-041 path.
 *
 * Memory-inject failures must NEVER fail the agent run; the runner wraps
 * this call in try/catch so a broken table or a slow query degrades to
 * "no memory injected" rather than a 5xx for the user's task.
 */
export interface InjectMemoryResult {
  /**
   * Markdown block to append to the primary agent's inline prompt, or null
   * when every scope resolved to zero memories (legacy "skip append"
   * contract — the prompt stays byte-for-byte identical to the pre-RFC-041
   * path).
   */
  block: string | null
  /**
   * RFC-046: the post-clip snapshot of the rows the runner should persist
   * to `node_runs.injected_memories_json`. Always paired with `block`:
   * both null together or both non-null together.
   */
  snapshot: InjectedMemorySnapshot[] | null
}

export async function injectMemoryForRun(deps: {
  store: MemoryInjectionReadStore
  taskId: string
  primaryAgent: Agent
  dependents: readonly Agent[]
  budget?: ScopeBudget
  /** RFC-200 per-run nonce; absent preserves pre-upgrade rendering. */
  envelopeNonce?: string
}): Promise<InjectMemoryResult> {
  const taskRow = await deps.store.findTaskContext(deps.taskId)
  // If the task vanished mid-run there is genuinely no scope context to
  // resolve — better to skip inject than to crash the run.
  if (taskRow === null) return { block: null, snapshot: null }
  const workflowId =
    typeof taskRow.workflowId === 'string' && taskRow.workflowId.length > 0
      ? taskRow.workflowId
      : null
  // RFC-204: resolve the repo scope from the stored mirror id, not by joining
  // URLs. `tasks.repo_url` has been REDACTED at write since RFC-054 W3-4, so
  // `repo_url == cached_repos.url` never matched for a credentialed URL — repo
  // scoped memory was silently skipped for private repos. The id join fixes
  // that and survives the credential being sealed.
  //
  // RFC-248: 从 `task_repos` 取**全部**成员仓的 cached_repo_id（去重），不再只看
  // `tasks.cached_repo_id`（那是 repos[0] 的镜像）。组任务有 N 个成员仓，每个仓
  // 自己的 repo 记忆都该注入。只读成员也算——它是「给 agent 看的参考资料」，
  // 关于它的经验同样有用。
  const repoRows = await deps.store.listTaskRepositoryIds(deps.taskId)
  const repoIdSet = new Set<string>()
  for (const repositoryId of repoRows) {
    if (repositoryId.length > 0) repoIdSet.add(repositoryId)
  }
  // 兜底：migration 0034 之前的老任务可能没有 task_repos 行。
  if (
    repoIdSet.size === 0 &&
    typeof taskRow.cachedRepoId === 'string' &&
    taskRow.cachedRepoId.length > 0
  ) {
    repoIdSet.add(taskRow.cachedRepoId)
  }
  // 只保留仍然存在的镜像行——删仓之后那条 scope 已经没有锚，注入它等于把
  // 一个「关于已不存在的仓」的规则塞给 agent。
  const repoIds =
    repoIdSet.size === 0 ? [] : await deps.store.filterExistingRepositoryIds([...repoIdSet])
  // RFC-248 D4: 只有用组启动的任务才注入组记忆；单仓直启不注入它所属的组。
  const repoGroupId =
    typeof taskRow.repoGroupId === 'string' && taskRow.repoGroupId.length > 0
      ? taskRow.repoGroupId
      : null
  const agentIds = [
    deps.primaryAgent.id,
    ...deps.dependents.map((d) => d.id).filter((id) => id !== deps.primaryAgent.id),
  ]
  const set = await loadInjectableMemories(deps.store, {
    agentIds,
    workflowId,
    repoIds,
    repoGroupId,
  })
  return formatMemoryBlockWithSnapshot(
    set,
    deps.budget ?? DEFAULT_INJECTION_BUDGET,
    memoryFencingForNonce(deps.envelopeNonce),
  )
}

/**
 * RFC-046: load the snapshot persisted on the retry_index=0 sibling row that
 * ANCHORS the current run's clarify generation. Used by runner.ts on the
 * envelope-followup retry path — that path skips inject so the model can resume
 * the same opencode session (which still has the original block in its
 * transcript), but the UI's "what memories did this attempt see" needs the
 * original list.
 *
 * RFC-074 PR-C: the retired `clarifyIteration` counter used to identify the
 * generation. We now anchor by id-order, mirroring the scheduler's canonical
 * `priorDoneGenerationsForRun`: a generation STARTS at the first top-level row
 * OR at any row whose nearest prior top-level row (by id) is `done`. A process /
 * envelope-followup retry only fires when the prior attempt is `failed`
 * (scheduler.ts decideEnvelopeFollowup: `prev.status !== 'failed' → no
 * followup`), so it follows a non-`done` row and belongs to the SAME
 * generation; a clarify-driven rerun follows the prior generation's `done` row
 * and STARTS a new one. The anchor for `ctx.runId` is the latest generation
 * start with id ≤ runId — the first attempt of the current generation, which
 * ran inject and persisted the snapshot.
 *
 * Note: this is deliberately retry-agnostic. The earlier `retry_index === 0`
 * anchor assumed every clarify rerun mints at retry=0; that is FALSE for a
 * cross-clarify DESIGNER rerun, which `triggerDesignerRerun` mints at
 * retry_index = max+1 (to keep the scheduler's self-clarify `isClarifyRerun`
 * gate false). Under the old anchor a designer rerun's followup resolved to the
 * PRIOR generation's snapshot; the boundary walk fixes that.
 *
 * Returns null when:
 *   - no anchor row exists (race);
 *   - the anchor row's column is NULL (legacy / non-agent / zero memories);
 *   - the JSON parses but is structurally invalid (degrade gracefully).
 */
export async function loadInjectedSnapshotFromFirstAttempt(
  store: MemoryInjectionReadStore,
  ctx: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    reviewIteration: number
    runId: string
  },
): Promise<InjectedMemorySnapshot[] | null> {
  const candidates = await store.listRunRecords(ctx)
  // Walk the in-scope top-level rows up to runId in id-order; the anchor is the
  // LATEST generation start (first row, or a row whose predecessor was `done`).
  const upToRun = candidates
    .filter((r) => r.id <= ctx.runId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let anchor: { id: string; injectedMemoriesJson: string | null } | undefined
  let prevStatus: string | undefined
  for (const r of upToRun) {
    if (prevStatus === undefined || prevStatus === 'done') anchor = r
    prevStatus = r.status
  }
  if (anchor?.injectedMemoriesJson == null) return null
  return parseInjectedSnapshotJson(anchor.injectedMemoriesJson)
}
