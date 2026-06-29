// RFC-128 §7 — locks `mergeSealedAnswers`: the per-question merge-write that lets a
// clarify round's `answers_json` accumulate sealed answers one (or a few) at a time
// instead of being overwritten wholesale.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * GOLDEN-LOCK: merging into an EMPTY existing set returns the incoming array
//     byte-for-byte (whole-round one-shot seal == the old overwrite).
//   * incoming WINS per questionId (re-seal replaces in place, keeping position).
//   * existing answers for questions NOT in the incoming subset are preserved.
//   * never-before-seen incoming answers are appended in incoming order.
//   * inputs are not aliased/mutated (fresh array out).

import { describe, expect, test } from 'bun:test'
import { mergeSealedAnswers } from '../src/clarify'
import type { ClarifyAnswer } from '../src/schemas/clarify'

const ans = (qid: string, idx: number, text = ''): ClarifyAnswer => ({
  questionId: qid,
  selectedOptionIndices: [idx],
  selectedOptionLabels: [],
  customText: text,
})

describe('mergeSealedAnswers', () => {
  test('golden-lock: merge into empty returns the incoming array verbatim', () => {
    const incoming = [ans('q1', 0), ans('q2', 1)]
    const out = mergeSealedAnswers([], incoming)
    expect(out).toEqual(incoming)
    expect(JSON.stringify(out)).toBe(JSON.stringify(incoming))
  })

  test('appends a new sealed answer, preserving the prior one (per-question, not overwrite)', () => {
    const out = mergeSealedAnswers([ans('q1', 0)], [ans('q2', 1)])
    expect(out.map((a) => a.questionId)).toEqual(['q1', 'q2'])
    expect(out.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([0])
    expect(out.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([1])
  })

  test('incoming wins per questionId and keeps the existing position (re-seal replace)', () => {
    const out = mergeSealedAnswers([ans('q1', 0, 'old'), ans('q2', 0)], [ans('q1', 1, 'new')])
    expect(out.map((a) => a.questionId)).toEqual(['q1', 'q2']) // position kept
    expect(out[0]).toEqual(ans('q1', 1, 'new')) // value replaced
    expect(out[1]).toEqual(ans('q2', 0)) // sibling untouched
  })

  test('does not mutate either input array', () => {
    const existing = [ans('q1', 0)]
    const incoming = [ans('q2', 1)]
    const out = mergeSealedAnswers(existing, incoming)
    expect(existing).toHaveLength(1)
    expect(incoming).toHaveLength(1)
    expect(out).not.toBe(existing)
    expect(out).not.toBe(incoming)
  })
})
