// RFC-395 II-a A4: strict inline readers retain HEAD's values and exception boundaries.
// Expectations execute frozen HEAD fragments, never candidate projection output.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { headClarifyReaders } from './helpers/rfc395A4HeadReaders'

const answer = (questionId: string, customText = '') => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText,
})
const shapes = [
  null,
  '',
  '{broken',
  'null',
  '{}',
  '0',
  'false',
  '"legacy"',
  '[]',
  '[null]',
  '[{}]',
  JSON.stringify([answer('a', 'first'), answer('b'), answer('a', 'last')]),
]

function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    // The refactor may change a TypeError's local variable name; its class and
    // whether it escapes the reader are the behavior contract.
    if (!(error instanceof Error)) throw error
    return error instanceof TypeError
      ? { error: error.name }
      : { error: error.name, message: error.message }
  }
}

function compile(body: string): (...args: unknown[]) => unknown {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `function read(round, decodeLegacyClarifyAnswerColumns) { ${body} }`,
  )
  return new Function(`${js}\nreturn read`)() as (...args: unknown[]) => unknown
}

function queueReader(source: string) {
  return compile(`
    const originId = 'origin'
    const roundByOrigin = new Map()
    const log = { warn() {} }
    for (const ignored of [0]) {
      ${source}
    }
    return roundByOrigin.get(originId)
  `)
}

const queueSource = readFileSync(
  resolve(import.meta.dir, '../src/modules/collaboration/infrastructure/clarify/queue.ts'),
  'utf8',
)
const queueStart = queueSource.indexOf('    if (\n      round === undefined')
const queueEnd = queueSource.indexOf('\n  }\n\n  const result: AgentQueueEntry[]', queueStart)
if (queueStart < 0 || queueEnd < queueStart)
  throw new Error('clarify-queue-reader-source-not-found')
const currentQueue = queueReader(queueSource.slice(queueStart, queueEnd))
const headQueue = queueReader(headClarifyReaders.queue.source)
const headStrict = compile(`return ${headClarifyReaders.strictAnswers.source}`)
const headFollowup = compile(`
  ${headClarifyReaders.effective.source.replace(/^export /, '')}
  return ${headClarifyReaders.followup.source}
`)

describe('RFC-395 A4 HEAD inline-reader oracles', () => {
  for (const answersJson of shapes) {
    test(`strict answers preserve HEAD JSON shape: ${String(answersJson)}`, () => {
      const round = { answersJson }
      expect(outcome(() => decodeLegacyClarifyAnswerColumns(round).requireAnswers())).toEqual(
        outcome(() => headStrict(round)),
      )
    })
    for (const status of ['awaiting_human', 'answered', 'canceled', 'abandoned']) {
      test(`queue ${status} / ${String(answersJson)} preserves parse-skip versus map-throw`, () => {
        const round = {
          id: 'round',
          status,
          answersJson,
          questionsJson: '[{"id":"a"},{"id":"b"}]',
          askingShardKey: null,
        }
        expect(outcome(() => currentQueue(round, decodeLegacyClarifyAnswerColumns))).toEqual(
          outcome(() => headQueue(round)),
        )
      })
    }
    for (const draftAnswersJson of [
      null,
      '',
      '{broken',
      'null',
      '[]',
      '{}',
      '"old"',
      JSON.stringify({ a: answer('a', 'draft'), c: answer('c', 'kept') }),
    ]) {
      test(`follow-up answers ${String(answersJson)} / drafts ${String(draftAnswersJson)}`, () => {
        const round = { answersJson, draftAnswersJson }
        expect(
          outcome(() => decodeLegacyClarifyAnswerColumns(round).requireEffectiveAnswers()),
        ).toEqual(outcome(() => headFollowup(round)))
      })
    }
  }
  test('queue rejects malformed question JSON in the same catch, but non-array questions escape it', () => {
    for (const questionsJson of ['', '{bad', 'null', '{}', '[]', '[null]']) {
      const round = {
        id: 'round',
        status: 'answered',
        answersJson: '[]',
        questionsJson,
        askingShardKey: null,
      }
      expect(outcome(() => currentQueue(round, decodeLegacyClarifyAnswerColumns))).toEqual(
        outcome(() => headQueue(round)),
      )
    }
  })
  test('strict answer maps retain last duplicate and reject non-array / null entries', () => {
    for (const answersJson of shapes) {
      const round = { answersJson }
      const headMap = () => {
        const values = headStrict(round) as Array<{ questionId: string }>
        return new Map(values.map((value) => [value.questionId, value]))
      }
      expect(outcome(() => decodeLegacyClarifyAnswerColumns(round).requireAnswerMap())).toEqual(
        outcome(headMap),
      )
    }
  })
})
