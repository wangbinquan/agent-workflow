// RFC-041 PR4 — pure helpers in lib/memory.ts.
//
// Locks in the i18n keys returned by promoteActionToLabel and the
// four-bucket grouping shape so any future rename of the keys (or
// reshuffle of buckets) trips this guard before reaching the UI tests.

import { describe, expect, test } from 'vitest'
import type { Memory, MemorySummary } from '@agent-workflow/shared'
import {
  buildConflictCompare,
  formatMemoryRow,
  groupCandidatesByScope,
  promoteActionToLabel,
  sortByRecency,
  sourceKindLabel,
} from '@/lib/memory'

function summary(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_01',
    scopeType: 'workflow',
    scopeId: 'wf_x',
    title: 'Default',
    status: 'approved',
    tags: [],
    approvedAt: 1000,
    version: 1,
    distillAction: null,
    fusedIntoSkillId: null,
    ...overrides,
  }
}

describe('promoteActionToLabel', () => {
  test('new returns the new i18n key with empty params', () => {
    expect(promoteActionToLabel('new', null)).toEqual({
      i18nKey: 'memory.distillAction.new',
      params: {},
    })
  })

  test('update_of / duplicate_of / conflict_with include ref id in params', () => {
    expect(promoteActionToLabel('update_of', 'mem_42')).toEqual({
      i18nKey: 'memory.distillAction.updateOf',
      params: { id: 'mem_42' },
    })
    expect(promoteActionToLabel('duplicate_of', 'mem_43')).toEqual({
      i18nKey: 'memory.distillAction.duplicateOf',
      params: { id: 'mem_43' },
    })
    expect(promoteActionToLabel('conflict_with', 'mem_44')).toEqual({
      i18nKey: 'memory.distillAction.conflictWith',
      params: { id: 'mem_44' },
    })
  })

  test('missing ref id falls back to "?" instead of crashing rendering', () => {
    expect(promoteActionToLabel('conflict_with', null).params).toEqual({ id: '?' })
  })
})

describe('groupCandidatesByScope', () => {
  test('partitions rows into 4 scope buckets', () => {
    const rows: MemorySummary[] = [
      summary({ id: 'a1', scopeType: 'agent', scopeId: 'a' }),
      summary({ id: 'w1', scopeType: 'workflow', scopeId: 'w' }),
      summary({ id: 'r1', scopeType: 'repo', scopeId: 'r' }),
      summary({ id: 'g1', scopeType: 'global', scopeId: null }),
      summary({ id: 'a2', scopeType: 'agent', scopeId: 'a' }),
    ]
    const grouped = groupCandidatesByScope(rows)
    expect(grouped.agent.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(grouped.workflow.map((m) => m.id)).toEqual(['w1'])
    expect(grouped.repo.map((m) => m.id)).toEqual(['r1'])
    expect(grouped.global.map((m) => m.id)).toEqual(['g1'])
  })

  test('empty input → 4 empty buckets', () => {
    const grouped = groupCandidatesByScope([])
    expect(grouped).toEqual({ agent: [], workflow: [], repo: [], global: [] })
  })
})

describe('formatMemoryRow', () => {
  test('returns scope label key and pass-through fields', () => {
    const row = formatMemoryRow(
      summary({
        id: 'mem_99',
        scopeType: 'agent',
        title: 'Prefer plural collections',
        tags: ['api-naming'],
        approvedAt: 1700000000000,
      }),
    )
    expect(row).toEqual({
      id: 'mem_99',
      scopeLabelKey: 'memory.scope.agent',
      title: 'Prefer plural collections',
      tags: ['api-naming'],
      approvedAt: 1700000000000,
    })
  })
})

describe('sourceKindLabel', () => {
  test('maps each kind to its i18n key', () => {
    expect(sourceKindLabel('clarify')).toBe('memory.candidate.source.clarify')
    expect(sourceKindLabel('review')).toBe('memory.candidate.source.review')
    expect(sourceKindLabel('feedback')).toBe('memory.candidate.source.feedback')
    expect(sourceKindLabel('manual')).toBe('memory.candidate.source.manual')
  })
})

describe('sortByRecency', () => {
  test('sorts by approvedAt DESC and falls back to createdAt', () => {
    const rows = [
      { id: 'a', approvedAt: null, createdAt: 200 },
      { id: 'b', approvedAt: 100, createdAt: 50 },
      { id: 'c', approvedAt: 300, createdAt: 1 },
    ]
    const sorted = sortByRecency(rows)
    expect(sorted.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('buildConflictCompare', () => {
  test('emits stable left=existing / right=candidate slots', () => {
    const existing = mem({ id: 'old', title: 'Existing rule', bodyMd: 'old body', tags: ['t1'] })
    const candidate = mem({
      id: 'new',
      title: 'Refined rule',
      bodyMd: 'new body',
      tags: ['t1', 't2'],
    })
    const cmp = buildConflictCompare(existing, candidate)
    expect(cmp.left.id).toBe('old')
    expect(cmp.right.id).toBe('new')
    expect(cmp.left.tags).toEqual(['t1'])
    expect(cmp.right.tags).toEqual(['t1', 't2'])
  })
})

function mem(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id ?? 'mem_01',
    scopeType: 'workflow',
    scopeId: 'wf_x',
    title: overrides.title ?? 'X',
    bodyMd: overrides.bodyMd ?? 'body',
    tags: overrides.tags ?? [],
    status: 'approved',
    sourceKind: 'clarify',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: 1000,
    createdAt: 500,
    version: 1,
    fusedIntoSkillId: null,
  }
}
