// RFC-041 PR3 — runtime memory inject (RFC-061 follow-up rewrite).
//
// Original lifecycle: legacy runner.ts called injectMemoryForRun after
// building the inline opencode config and appended the resulting block
// to the primary agent's prompt. RFC-061 deleted runner.ts and the
// initial follow-up stubbed this file as a no-op. This rewrite restores
// the loader + formatter (still keyed off the live `memories` table —
// approval flow unchanged) and exposes it through a closure the
// agent-single NodeKindHandler can invoke at dispatch time.
//
// Differences from the pre-RFC-061 implementation:
//   - No legacy node_runs.injected_memories_json persistence. The RFC-046
//     snapshot column is gone with the table. If we want to record what
//     was injected per attempt, add a new event payload field (separate
//     PR); the loader keeps the snapshot in its return value so a future
//     event emitter can pick it up trivially.
//   - The loadInjectedSnapshotFromFirstAttempt envelope-followup helper is
//     gone — there is no first-attempt row to read from. The
//     retry-pending-auto SignalKindHandler is the projection-native path
//     for envelope-followup; it preserves the original session so the
//     opencode transcript still holds the original injected block.
//
// Design invariants (preserved):
//   - Empty result → return null. Caller skips append; prompt stays
//     byte-for-byte identical to the pre-RFC-041 path.
//   - Cheap token estimate (chars/4) — hot path per agent dispatch.
//   - Failures NEVER bubble up to crash the dispatch; caller wraps in
//     try/catch.

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Agent, InjectedMemorySnapshot } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { cachedRepos, memories, tasks } from '@/db/schema'

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
  agentIds: readonly string[]
  workflowId: string | null
  repoId: string | null
}

export async function loadInjectableMemories(
  db: DbClient,
  opts: LoadInjectableMemoriesOptions,
): Promise<InjectableMemorySet> {
  const out: InjectableMemorySet = {
    byScope: { agent: [], workflow: [], repo: [], global: [] },
  }

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
    for (const r of rows) out.byScope.workflow.push(rowToInjectable(r))
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
    for (const r of rows) out.byScope.repo.push(rowToInjectable(r))
  }

  const globalRows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.scopeType, 'global'), eq(memories.status, 'approved')))
    .orderBy(desc(memories.createdAt))
  for (const r of globalRows) out.byScope.global.push(rowToInjectable(r))

  return out
}

function rowToInjectable(r: typeof memories.$inferSelect): InjectableMemoryRow {
  return {
    id: r.id,
    scopeType: r.scopeType as InjectableMemoryRow['scopeType'],
    scopeId: r.scopeId,
    title: r.title,
    bodyMd: r.bodyMd,
    createdAt: r.createdAt,
    version: r.version,
    tags: parseTagsField(r.tags),
    sourceKind: r.sourceKind ?? 'manual',
    approvedAt: r.approvedAt ?? null,
  }
}

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

export function formatMemoryBlock(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
): string | null {
  return formatMemoryBlockWithSnapshot(set, budget).block
}

export function formatMemoryBlockWithSnapshot(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
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
    lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
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

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

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

export const DEFAULT_INJECTION_BUDGET = DEFAULT_BUDGET

export interface InjectMemoryResult {
  block: string | null
  snapshot: InjectedMemorySnapshot[] | null
}

/**
 * Top-level orchestrator. Resolves the task's workflow / repo / agent-
 * closure scope ids, loads matching approved memories, applies the
 * per-scope budget, returns block + snapshot. Returns block=null when
 * every scope is empty after clip.
 */
export async function injectMemoryForRun(deps: {
  db: DbClient
  taskId: string
  primaryAgent: Agent
  dependents: readonly Agent[]
  budget?: ScopeBudget
}): Promise<InjectMemoryResult> {
  const taskRow = (await deps.db.select().from(tasks).where(eq(tasks.id, deps.taskId)).limit(1))[0]
  if (taskRow === undefined) return { block: null, snapshot: null }
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
  return formatMemoryBlockWithSnapshot(set, deps.budget ?? DEFAULT_BUDGET)
}

/**
 * Defensive parser for the legacy node_runs.injected_memories_json column.
 * The column itself is gone with migration 0035, but the same JSON shape
 * may still appear on a future projection event payload — keep the
 * parser exported so callers don't reinvent it.
 */
export function parseInjectedSnapshotJson(raw: string | null): InjectedMemorySnapshot[] | null {
  if (raw === null || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter(
      (e): e is InjectedMemorySnapshot =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { id?: unknown }).id === 'string' &&
        typeof (e as { title?: unknown }).title === 'string',
    )
  } catch {
    return null
  }
}
