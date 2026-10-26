import {
  compareClarifyRoundInboxOrder,
  compareClarifyRoundRecency,
} from '@/modules/collaboration/domain/clarifyRoundOrder'
// RFC-395 C: target row concurrency, lifecycle and append races; authored for T18.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  ClarifyQuestionSchema,
  clarifyContentKey,
  clarifyFollowupContext,
  type ClarifyAnswer,
  type ClarifyFollowup,
} from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture, nodeRunFixture, clarifyRoundFixture } from './helpers/model'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  createClarifyAnswerWritePort,
  lockClarifyRound,
} from '@/modules/collaboration/infrastructure/clarifyAnswerWrite'
import { readClarifyAnswerProjection } from '@/modules/collaboration/infrastructure/clarifyAnswerQueries'
import { sealClarifyAnswers } from '@/modules/collaboration/domain/clarifyAnswers'
import {
  appendClarifyQuestions,
  clarifyQuestionsRevision,
} from '@/modules/collaboration/domain/clarifyQuestions'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createTaskArchiveCollaborationSectionReader } from '@/modules/collaboration/infrastructure/taskCollaborationReads'

const question = (id: string) =>
  ClarifyQuestionSchema.parse({
    id,
    title: id,
    kind: 'single',
    options: ['Yes', 'No'],
    mindmap: { categoryPath: ['Scope'] },
  })
const editor = { userId: 'local', displayName: 'Owner', role: 'owner' as const }
async function seed(db: PersistenceDb) {
  const id = randomUUID(),
    taskId = randomUUID(),
    origin = randomUUID(),
    source = randomUUID(),
    workflowId = randomUUID()
  const definition = {
    $schema_version: 7,
    inputs: [],
    outputs: [],
    edges: [],
    nodes: [
      { id: 'asking', kind: 'agent-single', agentName: 'asking' },
      {
        id: 'gate',
        kind: 'clarify',
        interactionMode: 'mindmap',
        mindmap: { categories: ['Scope'], instructions: '' },
      },
    ],
  }
  await workflowFixture(db, { id: workflowId, name: workflowId, definition, schemaVersion: 7 })
  await taskFixture(db, {
    id: taskId,
    workflowId,
    workflowSnapshot: definition,
    repoPath: '/tmp/clarify-target',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  await nodeRunFixture(db, { id: source, taskId, nodeId: 'asking', status: 'done' })
  await nodeRunFixture(db, { id: origin, taskId, nodeId: 'gate', status: 'awaiting_human' })
  const questions = [question('a'), question('b')]
  await clarifyRoundFixture(db, {
    id,
    taskId,
    askingNodeId: 'asking',
    askingNodeRunId: source,
    intermediaryNodeId: 'gate',
    intermediaryNodeRunId: origin,
    kind: 'self',
    questions,
    createdAt: 1,
  })
  const writer = createClarifyAnswerWritePort(db)
  const round = async () => {
    const { clarifyRounds } = tablesOf(db)
    return (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, id)))[0]!
  }
  const projection = async () => readClarifyAnswerProjection(db, await round())
  const save = (questionId: string, customText = questionId) =>
    writer.saveDraft({
      roundId: id,
      intermediaryNodeRunId: origin,
      questionId,
      value: { selectedOptionIndices: [], customText },
      editor,
    })
  const seal = async (ids: string[], freeze = false) =>
    databaseSessionFor(db).transaction(async (tx) => {
      await lockClarifyRound(tx, id)
      const { clarifyRounds } = tablesOf(tx)
      const current = (await tx.select().from(clarifyRounds).where(eq(clarifyRounds.id, id)))[0]!
      const value = await readClarifyAnswerProjection(tx, current)
      const incoming: ClarifyAnswer[] = ids.map((questionId) => ({
        questionId,
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: questionId,
      }))
      const transition = sealClarifyAnswers({
        state: value.state,
        questions,
        status: current.status,
        alreadySealed: new Set(value.answers?.map((answer) => answer.questionId)),
        incoming,
        directive: current.directive,
        now: 30,
        ...(freeze ? { sealedBy: editor.userId, sealedByRole: editor.role } : {}),
      })
      await writer.seal(tx, id, transition)
      return transition
    })
  return { id, taskId, origin, questions, writer, round, projection, save, seal }
}

describeEachProvider('RFC-395 C target clarify writes', (h) => {
  // T18 P3-B / T29: contenders enter the real writer transaction and per-question
  // lock. Both draft/attribution inserts must converge before the loser updates.
  test('same-question first saves serialize without duplicate drafts or attributions', async () => {
    const f = await seed(h.db)
    await Promise.all([f.save('a', 'first'), f.save('a', 'second')])
    const { clarifyAnswerDrafts, clarifyAnswerAttributions } = tablesOf(h.db)
    const drafts = await h.db
      .select()
      .from(clarifyAnswerDrafts)
      .where(eq(clarifyAnswerDrafts.roundId, f.id))
    const attributions = await h.db
      .select()
      .from(clarifyAnswerAttributions)
      .where(eq(clarifyAnswerAttributions.roundId, f.id))
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ questionId: 'a', occurrence: 0, ordinal: 0, revision: 2 })
    expect(['first', 'second']).toContain(JSON.parse(drafts[0]!.valueJson).customText)
    expect(attributions).toHaveLength(1)
    expect(attributions[0]).toMatchObject({ questionId: 'a', occurrence: 0, ordinal: 0 })
    expect(JSON.parse(attributions[0]!.valueJson)).toMatchObject({ userId: editor.userId })
    await f.save('a', 'last')
    expect((await f.projection()).draftAnswers?.a?.customText).toBe('last')
  })
  test('concurrent first seals serialize the answer insert under the round lock', async () => {
    const f = await seed(h.db)
    await Promise.all([f.seal(['a']), f.seal(['a'])])
    const { clarifyAnswers } = tablesOf(h.db)
    const answers = await h.db.select().from(clarifyAnswers).where(eq(clarifyAnswers.roundId, f.id))
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ questionId: 'a', occurrence: 0, ordinal: 0, revision: 2 })
    expect((await f.projection()).answers).toEqual([
      { questionId: 'a', selectedOptionIndices: [], selectedOptionLabels: [], customText: 'a' },
    ])
  })
  test('different questions survive concurrent saves; same question advances only its revision', async () => {
    const f = await seed(h.db)
    await Promise.all([f.save('a'), f.save('b')])
    expect((await f.projection()).draftAnswers).toEqual({
      a: { selectedOptionIndices: [], customText: 'a' },
      b: { selectedOptionIndices: [], customText: 'b' },
    })
    await f.save('a', 'last')
    const { clarifyAnswerDrafts } = tablesOf(h.db)
    const rows = await h.db
      .select()
      .from(clarifyAnswerDrafts)
      .where(eq(clarifyAnswerDrafts.roundId, f.id))
    expect(rows.find((row) => row.questionId === 'a')?.revision).toBe(2)
    expect(rows.find((row) => row.questionId === 'b')?.revision).toBe(1)
    expect(new Set(rows.map((row) => row.ordinal)).size).toBe(2)
    expect(rows.every((row) => row.occurrence === 0)).toBe(true)
  })
  test('unknown keys roll back and abandoned rounds retain their editing evidence', async () => {
    const f = await seed(h.db)
    await expect(f.save('unknown')).rejects.toMatchObject({ code: 'clarify-question-not-found' })
    expect((await f.round()).draftsRecorded).toBe(false)
    const { clarifyRounds } = tablesOf(h.db)
    await h.db.update(clarifyRounds).set({ kind: 'cross' }).where(eq(clarifyRounds.id, f.id))
    await f.save('a')
    const before = await f.projection()
    await f.writer.transition({ roundId: f.id, kind: 'abandon', now: 40 })
    await expect(f.save('b')).rejects.toMatchObject({ code: 'clarify-round-not-awaiting' })
    expect((await f.projection()).draftAnswers).toEqual(before.draftAnswers)
    expect((await f.projection()).answerAttributions).toEqual(before.answerAttributions)
    expect((await f.round()).abandonedAt).toBe(40)
  })
  test('partial seal keeps drafts; final seal freezes; reopen leaves independent attribution', async () => {
    const f = await seed(h.db)
    await Promise.all([f.save('a'), f.save('b')])
    expect((await f.seal(['b'])).fullySealed).toBe(false)
    expect((await f.round()).status).toBe('awaiting_human')
    expect((await f.projection()).draftAnswers).not.toBeNull()
    await f.seal(['a'], true)
    const final = await f.projection()
    expect(final.answers?.map((answer) => answer.questionId)).toEqual(['b', 'a'])
    expect(final.draftAnswers).toBeNull()
    expect((await f.round()).sealedQuestionSetKey).not.toBeNull()
    await f.writer.transition({ roundId: f.id, kind: 'reopen', expectedStatus: 'answered' })
    expect((await f.projection()).answers).toBeNull()
    expect((await f.projection()).answerAttributions).toEqual(final.answerAttributions)
    const archive = await h.session.transaction((tx) =>
      createTaskArchiveCollaborationSectionReader().load(tx, [f.taskId]),
    )
    expect(archive.rows.clarify_answers).toEqual([])
    expect(archive.rows.clarify_answer_drafts).toEqual([])
    expect(archive.rows.clarify_answer_attributions).toHaveLength(2)
  })
  test('append CAS rejects stale revisions and preserves a concurrent draft on another question', async () => {
    const f = await seed(h.db)
    const revision = appendClarifyQuestions(clarifyQuestionsRevision(f.questions), [question('c')])
    await Promise.all([
      h.session.transaction((tx) => f.writer.appendQuestions(tx, f.id, revision)),
      f.save('b'),
    ])
    expect((await f.round()).questionsRevision).toBe(2)
    expect((await f.projection()).draftAnswers?.b).toEqual({
      selectedOptionIndices: [],
      customText: 'b',
    })
    await expect(
      h.session.transaction((tx) => f.writer.appendQuestions(tx, f.id, revision)),
    ).rejects.toMatchObject({ code: 'clarify-question-set-changed' })
    await f.save('c')
    expect((await f.projection()).draftAnswers?.c).toEqual({
      selectedOptionIndices: [],
      customText: 'c',
    })
  })
  test('follow-up rejects a changed generation basis without losing the intervening draft', async () => {
    const f = await seed(h.db)
    const store = createClarifyFollowupStore(h.db, { publish: async () => {} })
    const current = await store.read(f.origin, 'a')
    const request: ClarifyFollowup = {
      requestId: 'followup',
      parentQuestionId: 'a',
      instruction: '',
      basis: clarifyContentKey(clarifyFollowupContext(current.questions, current.drafts, 'a')),
    }
    await f.save('a', 'changed')
    const added = {
      ...question('c'),
      mindmap: {
        categoryPath: ['Scope'],
        parentQuestionId: 'a',
        requestId: request.requestId,
        requestBasis: clarifyContentKey(request),
      },
    }
    await expect(
      store.append(f.origin, request, [added], new AbortController().signal, editor),
    ).rejects.toMatchObject({ code: 'clarify-followup-stale' })
    expect((await f.round()).questionsRevision).toBe(1)
    expect((await f.projection()).draftAnswers?.a).toEqual({
      selectedOptionIndices: [],
      customText: 'changed',
    })
  })
})

test('clarify inbox and latest lookup keep their different released tie rules', () => {
  const rows = [
    { id: 'a', createdAt: 1 },
    { id: 'z', createdAt: 1 },
    { id: 'n', createdAt: 2 },
  ]
  expect([...rows].sort(compareClarifyRoundInboxOrder).map((row) => row.id)).toEqual([
    'n',
    'z',
    'a',
  ])
  expect([...rows].sort(compareClarifyRoundRecency).map((row) => row.id)).toEqual(['n', 'a', 'z'])
})
