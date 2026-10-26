// RFC-395 II-a A4: all clarify projections share one decoder and memory consumes the collaboration query.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../src')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const co = 'modules/collaboration/'
const readers = [
  'infrastructure/clarifyRounds.ts',
  'infrastructure/clarify/service.ts',
  'infrastructure/clarify/queue.ts',
  'infrastructure/taskQuestions.ts',
  'infrastructure/collaborationCommittedEventWsProjector.ts',
  'infrastructure/clarifyFollowupStore.ts',
  'infrastructure/committedHumanInputQueries.ts',
  'infrastructure/clarifyAnswerQueries.ts',
]

function projectionViolations(text: string) {
  return [
    ...text.matchAll(
      /function (?:parseAnswersArray|parseAnswers|safeParseArray|parseArray|parseJsonRecord)\b/g,
    ),
    ...text.matchAll(/JSON\.parse\([^\n]*(?:answersJson|draftAnswersJson|answerAttributionsJson)/g),
  ].map((match) => match[0])
}
function memoryViolations(text: string) {
  return [...text.matchAll(/\bclarifyRounds\b|\banswersJson\b|\bclarify_rounds\b/g)].map(
    (match) => match[0],
  )
}

test('recorded readers use the same projection, without their former private parsers', () => {
  expect(readers.length).toBe(8)
  for (const path of readers) {
    const source = read(co + path)
    expect(source).toContain(
      path.endsWith('clarifyAnswerQueries.ts')
        ? 'decodeLegacyClarifyAnswerColumns('
        : 'readClarifyAnswerProjection(',
    )
    expect(projectionViolations(source)).toEqual([])
  }
  for (const [path, query] of [
    ['infrastructure/memoryDistillWorkStore.ts', 'listSelfSources'],
    ['infrastructure/memoryDistillReadStore.ts', 'listSelfQuestions'],
  ]) {
    const source = read('modules/memory/' + path)
    expect(source).toContain("from '@/modules/collaboration/public/queries'")
    expect(source).toContain('private readonly clarifyAnswers: ClarifyAnswerQueries')
    expect(source).toContain(`this.clarifyAnswers.${query}(ids)`)
    expect(memoryViolations(source)).toEqual([])
  }
  expect(memoryViolations(read('modules/memory/application/ports/distillWorkStore.ts'))).toEqual([])
  expect(read('bootstrap/daemonModules/memory.ts')).toContain(
    'clarifyAnswers: createClarifyAnswerQueries(input.db)',
  )
  expect(read(co + 'public/queries.ts')).not.toContain('export { createClarifyAnswerQueries }')
})

test('negative controls catch both old parsers and the old memory column contract', () => {
  expect(projectionViolations('function parseAnswersArray(raw) {}')).toHaveLength(1)
  expect(projectionViolations('JSON.parse(round.answersJson)')).toHaveLength(1)
  expect(projectionViolations('JSON.parse(round.draftAnswersJson)')).toHaveLength(1)
  expect(
    memoryViolations('db.select({ answersJson: clarifyRounds.answersJson }).from(clarifyRounds)'),
  ).not.toEqual([])
  expect(memoryViolations('readonly answersJson: string | null')).toEqual(['answersJson'])
  expect(projectionViolations('decodeLegacyClarifyAnswerColumns(round).optionalAnswers')).toEqual(
    [],
  )
})

test('seal participant is typed in ports and domain transition commits inside the existing seal transaction', () => {
  const seal = read(co + 'infrastructure/clarify/seal.ts')
  const writer = read(co + 'infrastructure/clarifyAnswerWrite.ts')
  const participant = read(co + 'application/ports/clarifySealDecisionParticipant.ts')
  expect(participant).toContain('readonly roundFullySealed: boolean')
  expect(participant).not.toContain('answersJson')
  expect(seal).not.toContain('export interface ClarifySealDecisionParticipantInTx')
  expect(seal).toContain('const transition = sealClarifyAnswers({')
  expect(seal).toContain(
    'await createClarifyAnswerWritePort(args.db).seal(tx, round.id, transition)',
  )
  expect(seal.indexOf('.seal(tx, round.id, transition)')).toBeLessThan(
    seal.indexOf('await args.decisionParticipant?.acceptTx('),
  )
  expect(seal).toContain('const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)')
  expect(seal).toContain('lockClarifyRound(tx, roundIdentity.id)')
  expect(writer).toContain('holdAggregateRoot(tx, clarifyRounds, clarifyRounds.id, input.roundId)')
  expect(seal).toContain('if (args.decisionParticipant && roundIdentity)')
  const root = seal.indexOf('await taskHumanGate.lockTask(roundIdentity.taskId)')
  const round = seal.indexOf('await lockClarifyRound(tx, roundIdentity.id)')
  expect(root).toBeGreaterThan(-1)
  expect(round).toBeGreaterThan(root)
  expect(seal.indexOf('await taskHumanGate.completeClarifyRun(')).toBeGreaterThan(round)
  expect(seal).not.toContain('getTaskQuestionWriteSem')
  for (const source of [writer, read(co + 'infrastructure/clarifyFollowupStore.ts')]) {
    expect(source).not.toMatch(/\.lockTask\(|getTaskQuestionWriteSem/)
  }
  expect(writer).not.toMatch(
    /answersJson|draftAnswersJson|answerAttributionsJson|saveClarifyQuestionDraft/,
  )
  expect(writer).toContain('eq(clarifyAnswerDrafts.revision, draft.revision)')
  expect(
    read('modules/task-execution/infrastructure/humanGatePersistenceParticipant.ts'),
  ).toContain('lockAggregateRoot(tx, tasks, tasks.id, taskId)')
  expect(read(co + 'domain/clarifyAnswers.ts')).toContain('freezeAnswerAttributions({')
  expect(read(co + 'infrastructure/clarifyRounds.ts')).not.toContain('buildFrozenAttributionSet')
})
