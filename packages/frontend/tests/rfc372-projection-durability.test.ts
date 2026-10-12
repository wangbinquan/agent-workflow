import { describe, expect, test } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
} from '@agent-workflow/shared'
import { projectClarifyMindmap, visibleMindmapNodes } from '../src/lib/clarify/mindmap/projection'
import { layoutMindmap } from '../src/lib/clarify/mindmap/layout'
import {
  createClarifyDraftDurabilityController,
  type ClarifyServerWrite,
} from '../src/lib/clarify/durability'

const question = (id: string, parentQuestionId?: string) =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['A', 'B'],
    mindmap: { categoryPath: ['Scope'], parentQuestionId },
  })
const answer = (id: string): ClarifyAnswer => ({
  questionId: id,
  selectedOptionIndices: [0],
  selectedOptionLabels: [],
  customText: '',
})

describe('RFC-372 shared projection and original draft controller', () => {
  test('collapsed branches aggregate all descendants; parent confirmation alone cannot complete a branch', () => {
    const questions = [question('a'), question('b', 'a'), question('c', 'a')]
    const answers = {
      a: { ...answer('a'), confirmedBasis: clarifyAnswerBasis(questions[0]!, answer('a')) },
      b: answer('b'),
    }
    const nodes = projectClarifyMindmap(questions, answers, new Set(), 'Root')
    expect(nodes[0]?.counts).toEqual({ done: 1, needs_detail: 1, needs_confirmation: 1 })
    expect(nodes.find((n) => n.id === 'q:a')?.status).toBe('needs_detail')
    const visible = visibleMindmapNodes(nodes, new Set(['q:a']))
    expect(visible.some((n) => n.id === 'q:b')).toBe(false)
    expect(visible.find((n) => n.id === 'q:a')?.counts).toEqual(nodes[0]?.counts)
    expect(
      projectClarifyMindmap(questions, answers, new Set(['a', 'b', 'c']), 'Root')[0]?.status,
    ).toBe('done')
  })
  test('5000 questions, 300 siblings and depth 100 stay iterative and preserve counts', () => {
    const questions = Array.from({ length: 5000 }, (_, i) =>
      question(String(i), i > 0 && i < 100 ? String(i - 1) : i >= 100 && i < 400 ? '0' : undefined),
    )
    const nodes = projectClarifyMindmap(questions, {}, new Set(), 'Root')
    const layout = layoutMindmap(nodes, 'root')
    expect(nodes[0]?.counts.needs_detail).toBe(5000)
    expect(layout.nodes).toHaveLength(nodes.length)
    expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(nodes.length)
  })
  test('new questions join the existing queue without losing edits; confirmation survives local/server persistence', async () => {
    const writes: ClarifyServerWrite[] = [],
      local: ClarifyAnswer[][] = []
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('a')],
      serverAnswers: [answer('a')],
      debounceMs: 0,
      writeLocal: async (w) => {
        local.push(w.answers)
      },
      writeServer: async (w) => {
        writes.push(w)
      },
    })
    const edited = { ...answer('a'), selectedOptionIndices: [1] }
    controller.recordChange([edited], 'a')
    controller.addQuestions([{ ...answer('b'), selectedOptionIndices: [] }])
    const b = { ...answer('b'), confirmedBasis: clarifyAnswerBasis(question('b'), answer('b')) }
    controller.recordChange([edited, b], 'b')
    await controller.flushLocal()
    await controller.flushServer()
    expect(controller.getStatus().kind).toBe('saved')
    expect(local.at(-1)).toEqual([edited, b])
    expect(writes.find((w) => w.questionId === 'b')?.answer.confirmedBasis).toBe(b.confirmedBasis)
    const restored = createClarifyDraftDurabilityController({
      initialAnswers: local.at(-1)!,
      serverAnswers: local.at(-1)!,
      writeLocal: async () => {},
      writeServer: async () => {},
    })
    expect(restored.getStatus().kind).toBe('saved')
    await controller.seal()
    await restored.seal()
  })
  test('follow-up flush rejects an unsaved server draft and can recover on retry', async () => {
    let fail = true
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('a')],
      serverAnswers: [answer('a')],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async () => {
        if (fail) throw new Error('offline')
      },
    })
    controller.recordChange([{ ...answer('a'), selectedOptionIndices: [1] }], 'a')
    await expect(controller.flushServer()).rejects.toThrow('offline')
    fail = false
    await controller.flushServer()
    await controller.flushLocal()
    expect(controller.getStatus().kind).toBe('saved')
    await controller.seal()
  })
})
