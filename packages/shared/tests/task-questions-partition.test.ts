// RFC-120 T7 — locks `partitionDesignerQuestionsByTarget` / `isOverrideTarget`:
// the pure core of override-aware designer rerun. The two invariants the whole
// "flexible final fixer" rests on:
//   * GOLDEN LOCK — no overrides ⟹ exactly one group {graphDesigner: all qids},
//     byte-for-byte the pre-reassign single-designer rerun (override 空 = 原行为).
//   * NO CROSS-POLLUTION — Q1→X, Q2→default Y ⟹ {X:[q1], Y:[q2]}; each target sees
//     ONLY its own questions, so X's rerun feedback can never leak Q2 (design §2.4).

import { describe, expect, test } from 'bun:test'
import { isOverrideTarget, partitionDesignerQuestionsByTarget } from '../src/task-questions'

const q = (questionId: string, graphDesignerNodeId: string, overrideNodeId: string | null = null) => ({
  questionId,
  graphDesignerNodeId,
  overrideNodeId,
})

describe('partitionDesignerQuestionsByTarget', () => {
  test('GOLDEN LOCK: no overrides → single group {graphDesigner: all qids}', () => {
    const out = partitionDesignerQuestionsByTarget([q('q1', 'coder'), q('q2', 'coder')])
    expect([...out.entries()]).toEqual([['coder', ['q1', 'q2']]])
  })

  test('NO CROSS-POLLUTION: Q1→override X, Q2→default Y → {X:[q1], Y:[q2]}', () => {
    const out = partitionDesignerQuestionsByTarget([q('q1', 'coder', 'fixer'), q('q2', 'coder')])
    expect(out.get('fixer')).toEqual(['q1'])
    expect(out.get('coder')).toEqual(['q2'])
    // fixer's group must NOT contain q2; coder's must NOT contain q1.
    expect(out.get('fixer')).not.toContain('q2')
    expect(out.get('coder')).not.toContain('q1')
  })

  test('multiple questions overridden to the same target coalesce', () => {
    const out = partitionDesignerQuestionsByTarget([
      q('q1', 'coder', 'fixer'),
      q('q2', 'coder', 'fixer'),
      q('q3', 'coder'),
    ])
    expect(out.get('fixer')).toEqual(['q1', 'q2'])
    expect(out.get('coder')).toEqual(['q3'])
  })

  test('order within a group is preserved (stable shard_key dictionary aggregation upstream)', () => {
    const out = partitionDesignerQuestionsByTarget([
      q('qb', 'coder'),
      q('qa', 'coder'),
      q('qc', 'coder'),
    ])
    expect(out.get('coder')).toEqual(['qb', 'qa', 'qc'])
  })

  test('empty input → empty map', () => {
    expect(partitionDesignerQuestionsByTarget([]).size).toBe(0)
  })
})

describe('isOverrideTarget', () => {
  const qs = [q('q1', 'coder', 'fixer'), q('q2', 'coder')]
  test('true for a node that some question is overridden TO', () => {
    expect(isOverrideTarget('fixer', qs)).toBe(true)
  })
  test('false for the graph designer when nothing is overridden to it', () => {
    expect(isOverrideTarget('coder', qs)).toBe(false)
  })
  test('false when there are no overrides at all (golden-lock target)', () => {
    expect(isOverrideTarget('coder', [q('q1', 'coder'), q('q2', 'coder')])).toBe(false)
  })
})
