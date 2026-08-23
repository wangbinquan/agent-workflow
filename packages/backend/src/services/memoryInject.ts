// RFC-041 PR3 — runtime memory inject.
//
// Called by runner.ts after buildInlineConfig: pulls every currently-approved
// memory matching the active 4 scopes (agent / workflow / repo / global),
// clips per-scope by the configured token budget, and renders a single
// "## Learned context" markdown block to append to the primary agent's
// inline `prompt` field.
//
// Design invariants (do not loosen without updating the grep guards in
// memory-inject.test.ts):
//   - The block is rendered between `--- BEGIN INJECTED MEMORY ---` and
//     `--- END INJECTED MEMORY ---` anchors so a future regex / strip pass
//     can find it without misparsing.
//   - When *every* scope returns zero memories, the function returns null
//     and the runner skips appending. We never emit an empty block — that
//     would pollute the prompt cache for the common pre-promotion state.
//   - Live read: each runNode call refetches. Mid-task a freshly approved
//     memory takes effect on the next runNode without explicit refresh
//     (this is the live-vs-snapshot tradeoff documented in design.md §6).
//   - Token estimate is intentionally cheap (chars/4) — runs in the hot
//     path of every node spawn, so the per-row cost must stay O(strlen).

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Agent, InjectedMemorySnapshot } from '@agent-workflow/shared'
import { fenceUntrusted, sanitizeInlineField } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { cachedRepos, memories, nodeRuns, tasks, taskRepos } from '@/db/schema'

export interface ScopeBudget {
  agent: number
  workflow: number
  repo: number
  /**
   * RFC-248: 仓库组 scope 的**独立**预算档。每档各自裁剪、互不抢额度
   * （`formatMemoryBlockWithSnapshot` 逐档 `clipByBudget`），所以加这一档不会
   * 挤掉现有任何一档的内容。
   */
  repoGroup: number
  global: number
}

const DEFAULT_BUDGET: ScopeBudget = {
  agent: 1500,
  workflow: 800,
  repo: 800,
  // 与 repo 同量级：组记忆讲的是「这几个仓一起怎么干活」，信息密度与单仓相当。
  repoGroup: 800,
  global: 500,
}

export interface InjectableMemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  createdAt: number
  /**
   * RFC-046: extra fields captured from the memories row at inject time so
   * the runner can persist a complete snapshot to
   * `node_runs.injected_memories_json`. Optional in the type signature so
   * older tests that build `InjectableMemoryRow` literals keep working; the
   * real loader populates them unconditionally and `toSnapshot` falls back
   * to safe defaults if a caller skipped them.
   */
  version?: number
  tags?: string[]
  sourceKind?: string
  approvedAt?: number | null
}

export interface InjectableMemorySet {
  byScope: {
    agent: InjectableMemoryRow[]
    workflow: InjectableMemoryRow[]
    repo: InjectableMemoryRow[]
    /** RFC-248 D4：用组启动时才非空。 */
    repoGroup: InjectableMemoryRow[]
    global: InjectableMemoryRow[]
  }
}

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
  db: DbClient,
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
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'agent'),
          inArray(memories.scopeId, uniqueAgentIds),
          eq(memories.status, 'approved'),
        ),
      )
      .orderBy(desc(memories.createdAt))
    const seen = new Set<string>()
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.byScope.agent.push(rowToInjectable(r))
    }
  }

  if (opts.workflowId !== null) {
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'workflow'),
          eq(memories.scopeId, opts.workflowId),
          eq(memories.status, 'approved'),
        ),
      )
      .orderBy(desc(memories.createdAt))
    out.byScope.workflow = rows.map(rowToInjectable)
  }

  if (opts.repoIds.length > 0) {
    // RFC-248: 组内 N 个成员仓的 repo 记忆共用 `budget.repo` 一档，按
    // createdAt DESC 统一排序后裁剪——不给每个仓单独配额，否则成员一多
    // 整块就撑爆了。
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'repo'),
          inArray(memories.scopeId, [...opts.repoIds]),
          eq(memories.status, 'approved'),
        ),
      )
      .orderBy(desc(memories.createdAt))
    out.byScope.repo = rows.map(rowToInjectable)
  }

  if (opts.repoGroupId !== null) {
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'repo_group'),
          eq(memories.scopeId, opts.repoGroupId),
          eq(memories.status, 'approved'),
        ),
      )
      .orderBy(desc(memories.createdAt))
    out.byScope.repoGroup = rows.map(rowToInjectable)
  }

  const globalRows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.scopeType, 'global'), eq(memories.status, 'approved')))
    .orderBy(desc(memories.createdAt))
  out.byScope.global = globalRows.map(rowToInjectable)

  return out
}

function rowToInjectable(row: {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  createdAt: number
  version: number
  tags: string
  sourceKind: string
  approvedAt: number | null
}): InjectableMemoryRow {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
    version: row.version,
    tags: parseTagsField(row.tags),
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
 * Render the markdown block the runner appends to the primary agent's
 * inline prompt. Returns null when *every* scope is empty after the
 * budget clip — the caller skips the append, leaving the prompt
 * byte-for-byte identical to legacy (pre-RFC-041) behavior. Order:
 *   agent (most-specific, listed first) → workflow → repo → global.
 */
/**
 * RFC-317 T39（CC-13）—— 记忆正文的围栏模式，**必传的闭合判别式**。
 *
 * 改造前这三个函数都是 `envelopeNonce = ''`：空 nonce 走「原样拼接、不加围栏」的分支
 * （`fenceUntrusted` 遇到空 nonce 同样原样返回）。也就是说**安全路径是你得记得去要的
 * 那一条**，而不加围栏是默认。今天唯一的生产调用点传了真 nonce、且被 RFC-200 的源码锁
 * 钉着那一行；但默认值意味着**任何**新调用点、以及每一行 nonce 为 '' 的历史 node_run，
 * 都会安静地落进不加围栏的分支——把「历史字节兼容」编码成默认值，而不是一个显式的、
 * 有类型的 legacy 模式，这是把逃生门装在了安全边界上。
 *
 * 现在两种模式都要**说出来**：`{ kind: 'fenced', nonce }` 或
 * `{ kind: 'legacy-unfenced' }`。后者的每一个使用点都在 import 图里可见、可 grep、可入账。
 */
export type MemoryEnvelopeFencing =
  | { readonly kind: 'fenced'; readonly nonce: string }
  | { readonly kind: 'legacy-unfenced' }

/**
 * 把一个**可能为空**的 nonce 转成显式模式。
 *
 * 空 nonce 只出现在两处历史入口：pre-RFC-200 的 `node_runs` 行没有 nonce，重建它们的
 * persona 片段必须逐字复刻当年的拼法。这里把那个判断收成**一个具名转换器**——它可以
 * 被 grep、被入账、被测试；而改造前它是散在三个公共函数签名上的默认参数值，每一个
 * 新调用点都会静默继承「不加围栏」。
 *
 * 新代码不要用它：直接传 `{ kind: 'fenced', nonce }`。
 */
export function memoryFencingForNonce(nonce: string | null | undefined): MemoryEnvelopeFencing {
  return nonce === null || nonce === undefined || nonce.length === 0
    ? { kind: 'legacy-unfenced' }
    : { kind: 'fenced', nonce }
}

export function formatMemoryBlock(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
  fencing: MemoryEnvelopeFencing,
): string | null {
  return formatMemoryBlockWithSnapshot(set, budget, fencing).block
}

/**
 * RFC-046: render the block AND return the post-clip rows as
 * `InjectedMemorySnapshot[]` so the runner can persist them to
 * `node_runs.injected_memories_json`. When `block === null` the snapshot
 * is also `null` (mirrors the legacy "skip append" contract). The block
 * text is byte-for-byte identical to the legacy `formatMemoryBlock` path
 * (grep-guarded in memory-inject.test.ts).
 */
export function formatMemoryBlockWithSnapshot(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
  fencing: MemoryEnvelopeFencing,
): { block: string | null; snapshot: InjectedMemorySnapshot[] | null } {
  const agent = clipByBudget(set.byScope.agent, budget.agent)
  const workflow = clipByBudget(set.byScope.workflow, budget.workflow)
  const repo = clipByBudget(set.byScope.repo, budget.repo)
  // RFC-248: repo_group 排在 repo 与 global 之间——比单个仓宽、比 global 窄。
  const repoGroup = clipByBudget(set.byScope.repoGroup, budget.repoGroup)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...agent, ...workflow, ...repo, ...repoGroup, ...global]
  if (all.length === 0) return { block: null, snapshot: null }
  const snapshot = all.map(toSnapshot)
  return {
    block: formatMemoryBlockFromSnapshot(snapshot, fencing),
    snapshot,
  }
}

/**
 * Rebuild the exact persona fragment represented by a persisted injection
 * snapshot. RFC-042 same-session follow-ups send only a short USER prompt, so
 * the original AGENT memory fragment must be reconstructed deterministically.
 *
 * The snapshot is already post-budget and in canonical scope/order, so this
 * path must not query live memories or clip against today's budget.
 */
export function formatMemoryBlockFromSnapshot(
  snapshot: readonly InjectedMemorySnapshot[] | null,
  fencing: MemoryEnvelopeFencing,
): string | null {
  if (snapshot === null || snapshot.length === 0) return null
  const lines: string[] = [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by an administrator. Treat them as soft preferences — they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
  ]
  for (const m of snapshot) {
    if (fencing.kind === 'legacy-unfenced') {
      // 历史字节兼容：pre-RFC-200 的 node_run 行没有 nonce，重建它们的 persona 片段时
      // 必须逐字复刻当年的拼法。这条分支现在只能被**显式点名**进入。
      lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
      continue
    }
    lines.push(`- [${m.scopeType}] ${sanitizeInlineField(m.title)}`)
    lines.push(fenceUntrusted(`memory:${m.id}`, m.bodyMd, fencing.nonce))
  }
  lines.push('--- END INJECTED MEMORY ---')
  return lines.join('\n')
}

function toSnapshot(row: InjectableMemoryRow): InjectedMemorySnapshot {
  return {
    id: row.id,
    version: row.version ?? 1,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    tags: row.tags ?? [],
    sourceKind: row.sourceKind ?? 'manual',
    approvedAt: row.approvedAt ?? null,
  }
}

/**
 * Token estimate — chars/4 is the standard cheap heuristic and matches
 * what e.g. tiktoken gives for English ASCII to within ±25%. Keep it
 * pure; the hot path runs once per agent spawn.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/**
 * Drop the oldest rows until the rendered cost fits the budget. Rows are
 * already ordered createdAt DESC by the loader, so we walk head-to-tail
 * accumulating cost and cut on first overflow.
 */
export function clipByBudget(
  rows: readonly InjectableMemoryRow[],
  budgetTokens: number,
): InjectableMemoryRow[] {
  if (budgetTokens <= 0) return []
  const out: InjectableMemoryRow[] = []
  let used = 0
  for (const r of rows) {
    const line = `- [${r.scopeType}] ${r.title} — ${r.bodyMd}\n`
    const cost = estimateTokens(line)
    if (used + cost > budgetTokens) break
    out.push(r)
    used += cost
  }
  return out
}

/** Exposed for tests + runner so the default is the single source of truth. */
export const DEFAULT_INJECTION_BUDGET = DEFAULT_BUDGET

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
  db: DbClient
  taskId: string
  primaryAgent: Agent
  dependents: readonly Agent[]
  budget?: ScopeBudget
  /** RFC-200 per-run nonce; absent preserves pre-upgrade rendering. */
  envelopeNonce?: string
}): Promise<InjectMemoryResult> {
  const taskRow = (await deps.db.select().from(tasks).where(eq(tasks.id, deps.taskId)).limit(1))[0]
  // If the task vanished mid-run there is genuinely no scope context to
  // resolve — better to skip inject than to crash the run.
  if (taskRow === undefined) return { block: null, snapshot: null }
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
  const repoRows = await deps.db
    .select({ cachedRepoId: taskRepos.cachedRepoId })
    .from(taskRepos)
    .where(eq(taskRepos.taskId, deps.taskId))
  const repoIdSet = new Set<string>()
  for (const r of repoRows) {
    if (typeof r.cachedRepoId === 'string' && r.cachedRepoId.length > 0)
      repoIdSet.add(r.cachedRepoId)
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
    repoIdSet.size === 0
      ? []
      : (
          await deps.db
            .select({ id: cachedRepos.id })
            .from(cachedRepos)
            .where(inArray(cachedRepos.id, [...repoIdSet]))
        ).map((r) => r.id)
  // RFC-248 D4: 只有用组启动的任务才注入组记忆；单仓直启不注入它所属的组。
  const repoGroupId =
    typeof taskRow.repoGroupId === 'string' && taskRow.repoGroupId.length > 0
      ? taskRow.repoGroupId
      : null
  const agentIds = [
    deps.primaryAgent.id,
    ...deps.dependents.map((d) => d.id).filter((id) => id !== deps.primaryAgent.id),
  ]
  const set = await loadInjectableMemories(deps.db, {
    agentIds,
    workflowId,
    repoIds,
    repoGroupId,
  })
  return formatMemoryBlockWithSnapshot(
    set,
    deps.budget ?? DEFAULT_BUDGET,
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
  db: DbClient,
  ctx: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    reviewIteration: number
    runId: string
  },
): Promise<InjectedMemorySnapshot[] | null> {
  const candidates = await db
    .select({
      id: nodeRuns.id,
      status: nodeRuns.status,
      json: nodeRuns.injectedMemoriesJson,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, ctx.taskId),
        eq(nodeRuns.nodeId, ctx.nodeId),
        eq(nodeRuns.iteration, ctx.iteration),
        ctx.shardKey === null ? isNull(nodeRuns.shardKey) : eq(nodeRuns.shardKey, ctx.shardKey),
        eq(nodeRuns.reviewIteration, ctx.reviewIteration),
        isNull(nodeRuns.parentNodeRunId),
      ),
    )
  // Walk the in-scope top-level rows up to runId in id-order; the anchor is the
  // LATEST generation start (first row, or a row whose predecessor was `done`).
  const upToRun = candidates
    .filter((r) => r.id <= ctx.runId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let anchor: { id: string; json: string | null } | undefined
  let prevStatus: string | undefined
  for (const r of upToRun) {
    if (prevStatus === undefined || prevStatus === 'done') anchor = r
    prevStatus = r.status
  }
  if (anchor?.json == null) return null
  return parseInjectedSnapshotJson(anchor.json)
}

/**
 * RFC-046: parse the raw JSON stored in `node_runs.injected_memories_json`.
 * Defensive — malformed payloads degrade to null rather than throw, so
 * neither the runner followup path nor the REST `rowToNodeRun` projection
 * can 5xx on a corrupted column.
 */
export function parseInjectedSnapshotJson(raw: string | null): InjectedMemorySnapshot[] | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: InjectedMemorySnapshot[] = []
    for (const item of parsed) {
      if (item == null || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      if (
        typeof m.id !== 'string' ||
        typeof m.version !== 'number' ||
        typeof m.scopeType !== 'string' ||
        typeof m.title !== 'string' ||
        typeof m.bodyMd !== 'string' ||
        typeof m.sourceKind !== 'string'
      ) {
        continue
      }
      out.push({
        id: m.id,
        version: m.version,
        scopeType: m.scopeType as InjectedMemorySnapshot['scopeType'],
        scopeId: typeof m.scopeId === 'string' ? m.scopeId : null,
        title: m.title,
        bodyMd: m.bodyMd,
        tags: Array.isArray(m.tags)
          ? (m.tags.filter((t) => typeof t === 'string') as string[])
          : [],
        sourceKind: m.sourceKind,
        approvedAt: typeof m.approvedAt === 'number' ? m.approvedAt : null,
      })
    }
    return out
  } catch {
    return null
  }
}
