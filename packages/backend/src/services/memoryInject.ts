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

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Agent } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { cachedRepos, memories, tasks } from '@/db/schema'

const DEFAULT_BUDGET = { agent: 1500, workflow: 800, repo: 800, global: 500 } as const

export type ScopeBudget = typeof DEFAULT_BUDGET

export interface InjectableMemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  createdAt: number
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
}): InjectableMemoryRow {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
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
): string | null {
  const agent = clipByBudget(set.byScope.agent, budget.agent)
  const workflow = clipByBudget(set.byScope.workflow, budget.workflow)
  const repo = clipByBudget(set.byScope.repo, budget.repo)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...agent, ...workflow, ...repo, ...global]
  if (all.length === 0) return null
  const lines: string[] = [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by an administrator. Treat them as soft preferences — they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
  ]
  for (const m of all) {
    lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
  }
  lines.push('--- END INJECTED MEMORY ---')
  return lines.join('\n')
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
export async function injectMemoryForRun(deps: {
  db: DbClient
  taskId: string
  primaryAgent: Agent
  dependents: readonly Agent[]
  budget?: ScopeBudget
}): Promise<string | null> {
  const taskRow = (await deps.db.select().from(tasks).where(eq(tasks.id, deps.taskId)).limit(1))[0]
  // If the task vanished mid-run there is genuinely no scope context to
  // resolve — better to skip inject than to crash the run.
  if (taskRow === undefined) return null
  const workflowId =
    typeof taskRow.workflowId === 'string' && taskRow.workflowId.length > 0
      ? taskRow.workflowId
      : null
  let repoId: string | null = null
  if (typeof taskRow.repoUrl === 'string' && taskRow.repoUrl.length > 0) {
    const repoRow = (
      await deps.db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(eq(cachedRepos.url, taskRow.repoUrl))
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
  return formatMemoryBlock(set, deps.budget ?? DEFAULT_BUDGET)
}
