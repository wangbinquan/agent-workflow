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
import { cachedRepos, memories, nodeRuns, tasks } from '@/db/schema'

export interface ScopeBudget {
  agent: number
  workflow: number
  repo: number
  global: number
}

const DEFAULT_BUDGET: ScopeBudget = { agent: 1500, workflow: 800, repo: 800, global: 500 }

export interface InjectableMemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
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
   * Resolved cached_repo.id for the task (looked up via repoUrl); null
   * when the task was launched from a path-mode worktree. The lookup is
   * the caller's responsibility because the runner already holds the
   * task row and we don't want a second SELECT per inject.
   */
  repoId: string | null
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
    byScope: { agent: [], workflow: [], repo: [], global: [] },
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

  if (opts.repoId !== null) {
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'repo'),
          eq(memories.scopeId, opts.repoId),
          eq(memories.status, 'approved'),
        ),
      )
      .orderBy(desc(memories.createdAt))
    out.byScope.repo = rows.map(rowToInjectable)
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
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
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
export function formatMemoryBlock(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
  envelopeNonce = '',
): string | null {
  return formatMemoryBlockWithSnapshot(set, budget, envelopeNonce).block
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
  envelopeNonce = '',
): { block: string | null; snapshot: InjectedMemorySnapshot[] | null } {
  const agent = clipByBudget(set.byScope.agent, budget.agent)
  const workflow = clipByBudget(set.byScope.workflow, budget.workflow)
  const repo = clipByBudget(set.byScope.repo, budget.repo)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...agent, ...workflow, ...repo, ...global]
  if (all.length === 0) return { block: null, snapshot: null }
  const lines: string[] = [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by an administrator. Treat them as soft preferences — they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
  ]
  for (const m of all) {
    if (envelopeNonce.length === 0) {
      lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
      continue
    }
    lines.push(`- [${m.scopeType}] ${sanitizeInlineField(m.title)}`)
    lines.push(fenceUntrusted(`memory:${m.id}`, m.bodyMd, envelopeNonce))
  }
  lines.push('--- END INJECTED MEMORY ---')
  return { block: lines.join('\n'), snapshot: all.map(toSnapshot) }
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
  let repoId: string | null = null
  if (typeof taskRow.cachedRepoId === 'string' && taskRow.cachedRepoId.length > 0) {
    const repoRow = (
      await deps.db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, taskRow.cachedRepoId))
        .limit(1)
    )[0]
    repoId = repoRow?.id ?? null
  }
  const agentIds = [
    deps.primaryAgent.id,
    ...deps.dependents.map((d) => d.id).filter((id) => id !== deps.primaryAgent.id),
  ]
  const set = await loadInjectableMemories(deps.db, {
    agentIds,
    workflowId,
    repoId,
  })
  return formatMemoryBlockWithSnapshot(set, deps.budget ?? DEFAULT_BUDGET, deps.envelopeNonce ?? '')
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
