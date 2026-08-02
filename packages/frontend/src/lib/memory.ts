// RFC-041 PR4 — pure helpers shared by the memory UI surface.
//
// Kept dependency-free so unit tests run in the vitest JSDOM env without
// pulling React/router. The UI layer composes these for labels, grouping,
// and conflict-comparison rendering.

import type {
  DistillAction,
  Memory,
  MemoryScope,
  MemorySourceKind,
  MemorySummary,
} from '@agent-workflow/shared'

export interface MemoryGroupedByScope {
  agent: MemorySummary[]
  workflow: MemorySummary[]
  repo: MemorySummary[]
  /** RFC-248: 第 5 种 scope——绑在仓库组上的记忆。 */
  repo_group: MemorySummary[]
  global: MemorySummary[]
}

/**
 * Translation lookup tag for a candidate's distillAction label.
 *
 * We return the i18n key (the *consumer* runs `t(key, { id })`) rather than
 * the localized string so the helper stays pure / JSDOM-test-friendly.
 */
export function promoteActionToLabel(
  action: DistillAction,
  referenceMemoryId: string | null,
): { i18nKey: string; params: Record<string, string> } {
  switch (action) {
    case 'new':
      return { i18nKey: 'memory.distillAction.new', params: {} }
    case 'update_of':
      return {
        i18nKey: 'memory.distillAction.updateOf',
        params: { id: referenceMemoryId ?? '?' },
      }
    case 'duplicate_of':
      return {
        i18nKey: 'memory.distillAction.duplicateOf',
        params: { id: referenceMemoryId ?? '?' },
      }
    case 'conflict_with':
      return {
        i18nKey: 'memory.distillAction.conflictWith',
        params: { id: referenceMemoryId ?? '?' },
      }
  }
}

/**
 * Bucket a flat list of memory summaries into the four-scope view used by
 * <MemoryByScopeBrowser /> and the resource-detail "Memories" sub-tab.
 * Buckets are insertion-ordered (so the caller can pre-sort once).
 */
export function groupCandidatesByScope(rows: MemorySummary[]): MemoryGroupedByScope {
  const out: MemoryGroupedByScope = {
    agent: [],
    workflow: [],
    repo: [],
    repo_group: [],
    global: [],
  }
  for (const r of rows) {
    out[r.scopeType].push(r)
  }
  return out
}

export interface FormattedMemoryRow {
  id: string
  scopeLabelKey: string
  title: string
  tags: string[]
  /** Numeric ms (caller decides formatting / locale). null when not yet approved. */
  approvedAt: number | null
}

/**
 * Translate a backend row into the shape a row component needs without
 * needing i18n / Date locale at the helper level. Keeps the row template
 * fully driven by data (no inline string concat in JSX).
 */
export function formatMemoryRow(memory: MemorySummary): FormattedMemoryRow {
  return {
    id: memory.id,
    scopeLabelKey: `memory.scope.${memory.scopeType}`,
    title: memory.title,
    tags: memory.tags,
    approvedAt: memory.approvedAt,
  }
}

/**
 * Resolve a source-kind enum value to the i18n key used in the candidate
 * source-link row ("From clarify 01H…"). Distinct helper because the
 * `manual` kind hides the id (admin manually wrote it; nothing to link).
 */
export function sourceKindLabel(kind: MemorySourceKind): string {
  return `memory.candidate.source.${kind}`
}

/**
 * Order memories by `approvedAt DESC, createdAt DESC` — the canonical order
 * for the All Approved tab and the per-scope browser. Pure & stable.
 */
export function sortByRecency<T extends { approvedAt: number | null; createdAt?: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const aT = a.approvedAt ?? a.createdAt ?? 0
    const bT = b.approvedAt ?? b.createdAt ?? 0
    return bT - aT
  })
}

/** Stable scope-tab ordering. */
// RFC-248（实现门 P2）：`repo_group` 也要能按 scope 浏览。漏掉它的话，用户在
// 新表单里建出来的组记忆只会出现在「全部已批准」里，在它自己那一档下永远看不到
// ——`groupCandidatesByScope` 早就分了这一档，只是没人展示。
export const SCOPE_TABS: ReadonlyArray<MemoryScope> = [
  'agent',
  'workflow',
  'repo',
  'repo_group',
  'global',
]

/**
 * Build the comparison rows used by <MemoryConflictCompareDialog />. The
 * dialog renders title / body / tags side-by-side; this helper enforces a
 * stable left=existing right=candidate ordering so the snapshot test can
 * lock the column slots.
 */
export interface ConflictComparePayload {
  left: { id: string; title: string; bodyMd: string; tags: string[] }
  right: { id: string; title: string; bodyMd: string; tags: string[] }
}

export function buildConflictCompare(existing: Memory, candidate: Memory): ConflictComparePayload {
  return {
    left: {
      id: existing.id,
      title: existing.title,
      bodyMd: existing.bodyMd,
      tags: existing.tags,
    },
    right: {
      id: candidate.id,
      title: candidate.title,
      bodyMd: candidate.bodyMd,
      tags: candidate.tags,
    },
  }
}
