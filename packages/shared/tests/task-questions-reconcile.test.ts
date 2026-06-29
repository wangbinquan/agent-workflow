// RFC-120 — locks `reconcileDesiredEntries`: the pure derivation of a clarify
// round's "handler entries" (问题 × 承接角色) for the task question list.
//
// RFC-128 — the designer gate moved from the whole-round `roundAnswered` boolean
// to the per-question `questionSealed[qid]` map (design.md §4). Each lock below
// is preserved by mapping the old `roundAnswered: true/false` to "all questions
// sealed" / "none sealed", and a new describe block locks the PARTIAL gate:
// sealing Q1 emits Q1's designer entry while an unsealed Q2 emits none.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * self round → exactly one {self} entry per question, default target = the
//     asking node (阻塞-产出型, not re-targetable); ignores seal/scope entirely.
//   * cross round → a {questioner} entry ALWAYS exists (the questioner re-runs
//     regardless of scope); a {designer} entry exists ONLY when that question is
//     SEALED AND its scope === 'designer'.
//   * **unsealed cross question → questioner only, NO designer entry** — scope is
//     an answer-time human choice; before sealing it is unknown, so we must NOT
//     synthesize a designer entry from CLARIFY_QUESTION_SCOPE_DEFAULT at create
//     time (design.md §3.1 / §2.2 / RFC-128 §4).
//   * sealed cross question with a missing scope key → falls back to designer
//     (RFC-059 default) → designer entry present.
//   * graph nodes that don't resolve → defaultTargetNodeId is null (entry still
//     collected; UI prompts "no default handler, reassign").

import { describe, expect, test } from 'bun:test'
import { reconcileDesiredEntries, type ReconcileRoundInput } from '../src/task-questions'

const Q = (id: string, title = `q-${id}`) => ({ id, title })

const graph = {
  askingNodeId: 'ask',
  questionerNodeId: 'quest',
  designerNodeId: 'design',
}

/** Convenience: `allSealed` marks every passed question sealed (= old
 *  `roundAnswered: true`); otherwise pass an explicit per-question map. */
function run(
  partial: Partial<ReconcileRoundInput> &
    Pick<ReconcileRoundInput, 'kind'> & { allSealed?: boolean },
) {
  const questions = partial.questions ?? [Q('q1')]
  const { allSealed, ...rest } = partial
  const questionSealed =
    partial.questionSealed ??
    (allSealed ? Object.fromEntries(questions.map((q) => [q.id, true])) : {})
  return reconcileDesiredEntries({
    questions,
    scopes: {},
    graph,
    ...rest,
    questionSealed,
  })
}

describe('reconcileDesiredEntries — self', () => {
  test('one self entry per question, default target = asking node', () => {
    const out = run({ kind: 'self', questions: [Q('q1'), Q('q2')] })
    expect(out).toEqual([
      {
        questionId: 'q1',
        questionTitle: 'q-q1',
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: 'ask',
      },
      {
        questionId: 'q2',
        questionTitle: 'q-q2',
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: 'ask',
      },
    ])
  })

  test('self ignores seal / scopes entirely', () => {
    const sealed = run({ kind: 'self', allSealed: true, scopes: { q1: 'questioner' } })
    const unsealed = run({ kind: 'self', questionSealed: {} })
    expect(sealed).toEqual(unsealed)
  })
})

describe('reconcileDesiredEntries — cross unsealed (scope unknown)', () => {
  test('questioner entry only — NO designer entry before sealing', () => {
    const out = run({ kind: 'cross', questionSealed: {}, questions: [Q('q1'), Q('q2')] })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q2:questioner',
    ])
    expect(out.every((e) => e.roleKind !== 'designer')).toBe(true)
    expect(out[0].defaultTargetNodeId).toBe('quest')
  })
})

describe('reconcileDesiredEntries — cross sealed', () => {
  test('designer-scoped (default) → questioner + designer (the 两条 case)', () => {
    const out = run({ kind: 'cross', allSealed: true, scopes: { q1: 'designer' } })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner', 'designer'])
    const designer = out.find((e) => e.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe('design')
  })

  test('questioner-scoped → questioner only', () => {
    const out = run({ kind: 'cross', allSealed: true, scopes: { q1: 'questioner' } })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner'])
  })

  test('missing scope key on sealed round → designer fallback (RFC-059 default)', () => {
    const out = run({ kind: 'cross', allSealed: true, scopes: {} })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner', 'designer'])
  })

  test('mixed scopes are per-question', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questionSealed: { q1: true, q2: true, q3: true },
      questions: [Q('q1'), Q('q2'), Q('q3')],
      scopes: { q1: 'designer', q2: 'questioner', q3: 'designer' },
      graph,
    })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q1:designer',
      'q2:questioner',
      'q3:questioner',
      'q3:designer',
    ])
  })
})

// RFC-128 §4 / AC-2 — the per-question seal gate. Sealing only SOME questions of a
// round must surface ONLY the sealed designer-scope questions' designer entries; the
// unsealed siblings stay questioner-only (their scope is still unknown). The
// questioner entries are unconditional (always present regardless of seal).
describe('reconcileDesiredEntries — cross PARTIAL seal (RFC-128 per-question gate)', () => {
  test('seal Q1 (designer scope), Q2 unsealed → Q1 designer entry emitted, Q2 has none', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questions: [Q('q1'), Q('q2')],
      // Q1 sealed, Q2 not yet sealed.
      questionSealed: { q1: true },
      // Scope is only meaningful once sealed; Q1 designer-scoped, Q2's scope unknown.
      scopes: { q1: 'designer', q2: 'designer' },
      graph,
    })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q1:designer', // Q1 sealed + designer-scope → designer entry appears
      'q2:questioner', // Q2 unsealed → questioner only, NO designer entry yet
    ])
  })

  test('a sealed but questioner-scoped Q1 still emits no designer entry', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questions: [Q('q1'), Q('q2')],
      questionSealed: { q1: true },
      scopes: { q1: 'questioner' },
      graph,
    })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q2:questioner',
    ])
  })

  test('stop directive suppresses designer entries even when sealed (RFC-120 T9)', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questions: [Q('q1')],
      questionSealed: { q1: true },
      scopes: { q1: 'designer' },
      directive: 'stop',
      graph,
    })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner'])
  })
})

describe('reconcileDesiredEntries — unresolved graph nodes', () => {
  test('null graph node → defaultTargetNodeId null, entry still collected', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questionSealed: { q1: true },
      questions: [Q('q1')],
      scopes: { q1: 'designer' },
      graph: { askingNodeId: null, questionerNodeId: null, designerNodeId: null },
    })
    expect(out).toHaveLength(2)
    expect(out.every((e) => e.defaultTargetNodeId === null)).toBe(true)
  })
})
