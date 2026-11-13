// RFC-490 (design/RFC-490-mindmap-guided-thinking-and-panorama/design.md §2.2, §2.4, §2.5, §3):
//   §3   in the first round, a configured category nobody asked about yet is a follow-up
//        target, so the gap the mindmap shows can be filled in place; an unconfigured
//        empty path, and any empty path in a later round, is still an unknown target;
//   §2.4 the target and the direction a question was generated from are saved with it;
//   §2.2 a draft or a sealed answer that carries a real answer next to a skip status is
//        stored as that answer; a whole round submits with confirmed skips only;
//   §2.5 the task question board reports a sealed skip and the note left with it.
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { withO2Closure } from './helpers/o2Closure'
import {
  nodeRunFixture,
  readClarifyRoundFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyQuestionSetKey,
  isClarifyAnswerConfirmed,
  type ClarifyAnswer,
  type ClarifyDraftValue,
  type ClarifyFollowup,
  type ClarifyFollowupTarget,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { createClarifyRound } from '@/modules/collaboration/infrastructure/clarify/service'
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/clarify/seal'
import { saveClarifyDraft } from '@/modules/collaboration/infrastructure/clarifyRounds'
import { listTaskQuestions } from '@/modules/collaboration/infrastructure/taskQuestions'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createClarifyFollowupOperations } from '@/modules/collaboration/application/clarifyFollowup'
import { clarifyFollowupActivity } from '@/modules/collaboration/infrastructure/clarifyFollowupActivity'
import type { ClarifyFollowupGenerator } from '@/modules/collaboration/application/ports/clarifyFollowup'
import { ALL_TOOLS } from '@/mcp/tools'
import { toInputJsonSchema } from '@/util/zodJsonSchema'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const editor = { userId: 'fixture', displayName: 'Reviewer', role: 'owner' as const }
const events = { publish: async () => {} }
// 'Scope' has questions from the start; 'Reliability' and its child 'Recovery' have none.
const CATEGORIES = [['Scope'], ['Reliability', 'Recovery']]
const question = (id: string, categoryPath: string[] = ['Scope']) =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['A', 'B'],
    mindmap: { categoryPath },
  })
// The model files its answer under a category of its own choosing; what the framework
// does with it depends on the target (see clarifyFollowup.ts `generate`).
const generated =
  '<workflow-clarify>' +
  JSON.stringify({ questions: [question('new', ['Anything'])] }) +
  '</workflow-clarify>'

async function seed(
  h: ProviderHarness,
  options: {
    kind?: 'self' | 'cross'
    questions?: ClarifyQuestion[]
    /** Round index of a self round; 0 is the first round. */
    iteration?: number
  } = {},
) {
  const kind = options.kind ?? 'self'
  const questions = options.questions ?? [question('a')]
  const taskId = randomUUID(),
    workflowId = randomUUID(),
    askingNodeRunId = randomUUID()
  const definition = {
    $schema_version: 7,
    inputs: [],
    nodes: [
      { id: 'asking', kind: 'agent-single', agentName: 'asking' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      {
        id: 'gate',
        kind: kind === 'self' ? 'clarify' : 'clarify-cross-agent',
        interactionMode: 'mindmap',
        mindmap: { categories: CATEGORIES, instructions: '' },
      },
    ],
    edges: [],
    outputs: [],
  }
  await workflowFixture(h.db, {
    id: workflowId,
    name: 'rfc490',
    definition: JSON.stringify(definition),
    schemaVersion: 7,
  })
  await taskFixture(h.db, {
    id: taskId,
    name: 'rfc490',
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc490',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await nodeRunFixture(h.db, {
    id: askingNodeRunId,
    taskId,
    nodeId: 'asking',
    status: 'done',
    iteration: 0,
  })
  const common = {
    db: h.db,
    taskId,
    askingNodeId: 'asking',
    askingNodeRunId,
    intermediaryNodeId: 'gate',
    questions,
  }
  const round = await createClarifyRound({
    ...withO2Closure(
      kind === 'self'
        ? { ...common, kind, askingShardKey: null, iteration: options.iteration ?? 0 }
        : { ...common, kind, targetConsumerNodeId: 'designer', loopIter: 0 },
    ),
    taskExecutionParticipants,
  })
  const nodeRunId = round.intermediaryNodeRunId
  const read = async () =>
    (await readClarifyRoundFixtures(h.db, { intermediaryNodeRunId: nodeRunId }))[0]!
  return {
    taskId,
    nodeRunId,
    read,
    stored: async () => JSON.parse((await read()).questions) as ClarifyQuestion[],
    drafts: async () =>
      JSON.parse((await read()).draftAnswers ?? '{}') as Record<string, ClarifyDraftValue>,
    answers: async () => JSON.parse((await read()).answers ?? '[]') as ClarifyAnswer[],
  }
}

function operations(h: ProviderHarness) {
  const store = createClarifyFollowupStore(h.db, taskExecutionParticipants, events)
  const prompts: string[] = []
  const generator: ClarifyFollowupGenerator = {
    generate: async (input) => {
      prompts.push(input.prompt)
      return generated
    },
  }
  const followups = createClarifyFollowupOperations(store, generator, clarifyFollowupActivity)
  /** A request against the round as it is now, the way the page builds one. */
  const request = async (
    nodeRunId: string,
    target: ClarifyFollowupTarget,
    instruction = '',
  ): Promise<ClarifyFollowup> => {
    const snapshot = await store.read(nodeRunId, target)
    return {
      requestId: randomUUID(),
      ...(typeof target === 'string'
        ? { parentQuestionId: target }
        : { categoryPath: [...target] }),
      instruction,
      basis: clarifyContentKey(clarifyFollowupContext(snapshot.questions, snapshot.drafts, target)),
    }
  }
  return { store, followups, prompts, request }
}
// The request JSON is the last paragraph of the prompt.
const requestJson = (prompt: string) =>
  JSON.parse(prompt.split('\n\n').at(-1)!) as Record<string, unknown>

const skip = (
  questionId: string,
  status: 'deferred' | 'not-applicable',
  rationale?: string,
): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
  decision: { status, ...(rationale === undefined ? {} : { rationale }) },
})
const confirm = (questions: readonly ClarifyQuestion[], answer: ClarifyAnswer): ClarifyAnswer => ({
  ...answer,
  confirmedBasis: clarifyAnswerBasis(questions.find((q) => q.id === answer.questionId)!, answer),
})

describeEachProvider('RFC-490 §3 an empty configured category is a first-round target', (h) => {
  for (const kind of ['self', 'cross'] as const)
    for (const categoryPath of [['Reliability', 'Recovery'], ['Reliability']])
      test(`${kind}: ${categoryPath.join(' / ')} accepts questions and files them under it`, async () => {
        const fixture = await seed(h, { kind })
        expect((await fixture.read()).iteration).toBe(0)
        const { store, followups, prompts } = operations(h)
        const snapshot = await store.read(fixture.nodeRunId, categoryPath)
        expect(snapshot.canAppend).toBe(true)
        expect(snapshot.categoryPaths).toEqual(CATEGORIES)
        const context = clarifyFollowupContext(snapshot.questions, snapshot.drafts, categoryPath)
        expect(context).toEqual([])
        const result = await followups.append(
          fixture.nodeRunId,
          {
            requestId: randomUUID(),
            categoryPath,
            instruction: 'Cover failover drills',
            basis: clarifyContentKey(context),
          },
          editor,
        )
        expect(result.questionIds).toHaveLength(1)
        const stored = await fixture.stored()
        expect(stored).toHaveLength(2)
        const added = stored.find((q) => q.id === result.questionIds[0])!
        // The model answered under ['Anything']; the question lands where the user asked.
        expect(added.mindmap).toMatchObject({
          categoryPath,
          requestTarget: 'category',
          requestInstruction: 'Cover failover drills',
        })
        expect(added.mindmap).not.toHaveProperty('parentQuestionId')
        // It is asked as a peer under the category, like any category direction.
        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain(
          'Add missing questions directly under the selected categoryPath',
        )
        // The round itself is untouched: same round, still open.
        expect((await fixture.read()).status).toBe('awaiting_human')
        expect((await fixture.read()).iteration).toBe(0)
      })

  test('both ends compute the same basis for an empty category, whatever else is answered', async () => {
    const fixture = await seed(h, { questions: [question('a'), question('b')] })
    const { store, followups, request } = operations(h)
    await saveClarifyDraft({
      db: h.db,
      intermediaryNodeRunId: fixture.nodeRunId,
      roundId: (await fixture.read()).id,
      questionId: 'a',
      value: { selectedOptionIndices: [1], customText: '' },
      editor,
      draftEvents: events,
    })
    // What the page computes from its own copy of the round…
    const client = clarifyContentKey(
      clarifyFollowupContext(await fixture.stored(), await fixture.drafts(), ['Reliability']),
    )
    // …is what the server computes from the stored round: the empty branch.
    expect(client).toBe(clarifyContentKey([]))
    const built = await request(fixture.nodeRunId, ['Reliability'])
    expect(built.basis).toBe(client)
    await expect(
      followups.append(fixture.nodeRunId, { ...built, basis: 'v2:stale' }, editor),
    ).rejects.toMatchObject({ code: 'clarify-followup-stale' })
    expect(await fixture.stored()).toHaveLength(2)
    const appended = await followups.append(fixture.nodeRunId, built, editor)
    expect(await fixture.stored()).toHaveLength(3)

    // Once filled, the category is an ordinary one: its branch is no longer empty, so a
    // second request made against the old, empty view is stale.
    const snapshot = await store.read(fixture.nodeRunId, ['Reliability'])
    const context = clarifyFollowupContext(snapshot.questions, snapshot.drafts, ['Reliability'])
    expect(context.map((entry) => entry.question.id)).toEqual(appended.questionIds)
    await expect(
      followups.append(
        fixture.nodeRunId,
        { requestId: randomUUID(), categoryPath: ['Reliability'], instruction: '', basis: client },
        editor,
      ),
    ).rejects.toMatchObject({ code: 'clarify-followup-stale' })
    expect(await fixture.stored()).toHaveLength(3)
  })

  test('only the empty category request lists the existing question titles', async () => {
    const fixture = await seed(h, { questions: [question('a'), question('b')] })
    const { followups, prompts, request } = operations(h)
    const ask = async (target: ClarifyFollowupTarget) => {
      await followups.append(fixture.nodeRunId, await request(fixture.nodeRunId, target), editor)
      return requestJson(prompts.at(-1)!)
    }
    const empty = await ask(['Reliability', 'Recovery'])
    expect(empty.existingQuestionTitles).toEqual(['Question a', 'Question b'])
    expect(empty.branch).toEqual([])
    expect(empty.categoryPath).toEqual(['Reliability', 'Recovery'])
    expect(empty.configuredCategoryPaths).toEqual(CATEGORIES)

    const populated = await ask(['Scope'])
    expect(populated).not.toHaveProperty('existingQuestionTitles')
    expect((populated.branch as unknown[]).length).toBe(2)
    // The category filled a moment ago is populated now, and is treated like any other.
    const filled = await ask(['Reliability', 'Recovery'])
    expect(filled).not.toHaveProperty('existingQuestionTitles')
    expect((filled.branch as unknown[]).length).toBe(1)
    const root = await ask([])
    expect(root).not.toHaveProperty('existingQuestionTitles')
    expect(root.categoryPath).toEqual([])
    const deepened = await ask('a')
    expect(deepened).not.toHaveProperty('existingQuestionTitles')
    expect(deepened).not.toHaveProperty('categoryPath')

    expect(prompts).toHaveLength(5)
    for (const prompt of prompts) {
      // §2.3: every follow-up prompt opens as before and now rules out re-asking a question
      // the user marked not applicable.
      expect(prompt.startsWith('Ask 1–4 consequential follow-up questions')).toBe(true)
      expect(prompt.split('\n\n')[0]).toContain(
        'Never ask again a question the user marked not applicable.',
      )
    }
  })

  test('an empty path that is not configured is still an unknown target', async () => {
    const fixture = await seed(h)
    const { store, followups } = operations(h)
    for (const path of [
      ['Unknown'],
      ['Reliability', 'Other'],
      // Longer than the configured path it starts with.
      ['Reliability', 'Recovery', 'Drills'],
      ['Scope', 'Unknown'],
      // Category names are compared as written.
      ['reliability'],
    ]) {
      await expect(store.read(fixture.nodeRunId, path)).rejects.toMatchObject({
        code: 'clarify-question-not-found',
        status: 404,
      })
      await expect(
        followups.append(
          fixture.nodeRunId,
          {
            requestId: randomUUID(),
            categoryPath: path,
            instruction: '',
            basis: clarifyContentKey([]),
          },
          editor,
        ),
      ).rejects.toMatchObject({ code: 'clarify-question-not-found' })
    }
    await expect(store.read(fixture.nodeRunId, 'missing')).rejects.toMatchObject({
      code: 'clarify-question-not-found',
    })
    expect(await fixture.stored()).toHaveLength(1)
  })

  test('in a later round an empty configured category is an unknown target', async () => {
    const fixture = await seed(h, { iteration: 1 })
    expect((await fixture.read()).iteration).toBe(1)
    const { store, followups, request } = operations(h)
    for (const path of [['Reliability'], ['Reliability', 'Recovery']]) {
      await expect(store.read(fixture.nodeRunId, path)).rejects.toMatchObject({
        code: 'clarify-question-not-found',
        status: 404,
      })
      await expect(
        followups.append(
          fixture.nodeRunId,
          {
            requestId: randomUUID(),
            categoryPath: path,
            instruction: '',
            basis: clarifyContentKey([]),
          },
          editor,
        ),
      ).rejects.toMatchObject({ code: 'clarify-question-not-found' })
    }
    expect(await fixture.stored()).toHaveLength(1)
    // Everything that has questions works as in any round.
    for (const target of [['Scope'], [], 'a'] as const) {
      expect((await store.read(fixture.nodeRunId, target)).canAppend).toBe(true)
      await followups.append(fixture.nodeRunId, await request(fixture.nodeRunId, target), editor)
    }
    expect(await fixture.stored()).toHaveLength(4)
  })

  test('an empty category stops accepting questions once the round is answered', async () => {
    const fixture = await seed(h)
    const { store, followups } = operations(h)
    expect((await store.read(fixture.nodeRunId, ['Reliability'])).canAppend).toBe(true)
    const questions = await fixture.stored()
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      wholeRound: true,
      questionSetKey: clarifyQuestionSetKey(questions),
      answers: [confirm(questions, skip('a', 'not-applicable'))],
    })
    expect((await fixture.read()).status).toBe('answered')
    expect((await store.read(fixture.nodeRunId, ['Reliability'])).canAppend).toBe(false)
    await expect(
      followups.append(
        fixture.nodeRunId,
        {
          requestId: randomUUID(),
          categoryPath: ['Reliability'],
          instruction: '',
          basis: clarifyContentKey([]),
        },
        editor,
      ),
    ).rejects.toMatchObject({ code: 'clarify-followup-closed' })
    expect(await fixture.stored()).toHaveLength(1)
  })

  test('an empty category follows the map: open while any question is unsealed', async () => {
    // It has no question of its own to seal, so it closes with the last open question of
    // the round, like a request on the whole map does.
    const fixture = await seed(h, { questions: [question('a'), question('b')] })
    const { store } = operations(h)
    const choose = (questionId: string): ClarifyAnswer => ({
      questionId,
      selectedOptionIndices: [0],
      selectedOptionLabels: [],
      customText: '',
    })
    const open = async (target: string[]) => (await store.read(fixture.nodeRunId, target)).canAppend
    expect([await open(['Reliability']), await open([])]).toEqual([true, true])
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      answers: [choose('a')],
    })
    // One question is sealed, one is open: the map, and the gap in it, still take questions.
    expect((await fixture.read()).status).toBe('awaiting_human')
    expect([await open(['Reliability']), await open([])]).toEqual([true, true])
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      answers: [choose('b')],
    })
    expect([await open(['Reliability']), await open([])]).toEqual([false, false])
  })
})

describeEachProvider('RFC-490 §2.4 a generated question keeps where it came from', (h) => {
  test('the target is always saved; the direction only when one was given', async () => {
    const fixture = await seed(h)
    const { followups, request } = operations(h)
    const append = async (target: ClarifyFollowupTarget, instruction: string) => {
      const result = await followups.append(
        fixture.nodeRunId,
        await request(fixture.nodeRunId, target, instruction),
        editor,
      )
      return (await fixture.stored()).find((q) => q.id === result.questionIds[0])!.mindmap!
    }
    // The direction is kept as it was requested, quoting wrapper included.
    const quoted = 'Quoted passage: "No baseline"\n\nCheck the evidence before deciding.'
    const deepened = await append('a', quoted)
    expect(deepened).toMatchObject({
      categoryPath: ['Scope'],
      parentQuestionId: 'a',
      requestTarget: 'question',
      requestInstruction: quoted,
    })
    const plain = await append('a', '')
    expect(plain.requestTarget).toBe('question')
    expect(plain).not.toHaveProperty('requestInstruction')
    const blank = await append('a', '   ')
    expect(blank.requestTarget).toBe('question')
    expect(blank).not.toHaveProperty('requestInstruction')

    const peer = await append(['Scope'], 'Also consider quotas')
    expect(peer).toMatchObject({
      categoryPath: ['Scope'],
      requestTarget: 'category',
      requestInstruction: 'Also consider quotas',
    })
    expect(peer).not.toHaveProperty('parentQuestionId')
    expect(await append(['Scope'], '')).not.toHaveProperty('requestInstruction')

    const whole = await append([], 'What is missing overall?')
    expect(whole).toMatchObject({
      // For the whole map the model's own category is kept.
      categoryPath: ['Anything'],
      requestTarget: 'root',
      requestInstruction: 'What is missing overall?',
    })
    const wholePlain = await append([], '')
    expect(wholePlain.requestTarget).toBe('root')
    expect(wholePlain).not.toHaveProperty('requestInstruction')

    // Every stored question still parses, and the original one carries no origin.
    const stored = await fixture.stored()
    expect(stored.map((q) => ClarifyQuestionSchema.parse(q))).toEqual(stored)
    expect(stored[0]!.mindmap).toEqual({ categoryPath: ['Scope'] })
  })

  test('replaying a request adds nothing and generates nothing', async () => {
    const fixture = await seed(h)
    const { followups, prompts, request } = operations(h)
    for (const target of [['Reliability', 'Recovery'], 'a'] as const) {
      const first = await request(fixture.nodeRunId, target, 'Why this option?')
      const appended = await followups.append(fixture.nodeRunId, first, editor)
      const count = (await fixture.stored()).length
      const generations = prompts.length
      expect(await followups.append(fixture.nodeRunId, first, editor)).toEqual(appended)
      expect(await followups.start(fixture.nodeRunId, first, editor)).toEqual({
        state: 'done',
        questionIds: appended.questionIds,
      })
      // Another process, with no memory of the request, recovers it from the stored round.
      expect(
        await createClarifyFollowupOperations(
          createClarifyFollowupStore(h.db, taskExecutionParticipants, events),
          {
            generate: async () => {
              throw new Error('must not generate again')
            },
          },
          clarifyFollowupActivity,
        ).append(fixture.nodeRunId, first, editor),
      ).toEqual(appended)
      expect(await fixture.stored()).toHaveLength(count)
      expect(prompts).toHaveLength(generations)
      // The same id with another direction is a different request, not a replay.
      await expect(
        followups.append(fixture.nodeRunId, { ...first, instruction: 'Something else' }, editor),
      ).rejects.toMatchObject({ code: 'clarify-followup-request-conflict' })
    }
    expect(await fixture.stored()).toHaveLength(3)
  })
})

describeEachProvider('RFC-490 §2.2 skips and stale skip statuses on the server', (h) => {
  test('confirmed skips submit the whole round; an unconfirmed skip is refused', async () => {
    const fixture = await seed(h, { questions: [question('a'), question('b')] })
    const questions = await fixture.stored()
    const seal = (answers: ClarifyAnswer[]) =>
      sealRoundQuestions({
        taskExecutionParticipants,
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        wholeRound: true,
        questionSetKey: clarifyQuestionSetKey(questions),
        answers,
      })
    const a = skip('a', 'not-applicable', 'No replica in the first release')
    const b = skip('b', 'deferred')
    await expect(seal([confirm(questions, a), b])).rejects.toMatchObject({
      code: 'clarify-confirmation-required',
    })
    // Confirmed as one skip, sent as the other: the confirmation does not carry over.
    await expect(
      seal([
        confirm(questions, a),
        { ...confirm(questions, b), decision: { status: 'not-applicable' } },
      ]),
    ).rejects.toMatchObject({ code: 'clarify-confirmation-required' })
    // An answer that is neither chosen, written nor skipped is still not submittable.
    await expect(
      seal([
        confirm(questions, a),
        confirm(questions, { ...b, decision: { rationale: 'Just a note' } }),
      ]),
    ).rejects.toMatchObject({ code: 'clarify-confirmation-required' })
    expect((await fixture.read()).status).toBe('awaiting_human')

    const sealed = await seal([confirm(questions, a), confirm(questions, b)])
    expect(sealed.roundFullySealed).toBe(true)
    expect((await fixture.read()).status).toBe('answered')
    const answers = await fixture.answers()
    expect(answers.map((answer) => answer.decision)).toEqual([a.decision, b.decision])
    for (const answer of answers) {
      expect(answer.selectedOptionIndices).toEqual([])
      expect(answer.selectedOptionLabels).toEqual([])
      expect(
        isClarifyAnswerConfirmed(questions.find((q) => q.id === answer.questionId)!, answer),
      ).toBe(true)
    }
  })

  test('a draft with a real answer is stored without the skip status; a skip is stored as it is', async () => {
    const fixture = await seed(h, {
      questions: [question('a'), question('b'), question('c'), question('d')],
    })
    const questions = await fixture.stored()
    const roundId = (await fixture.read()).id
    const save = (questionId: string, value: ClarifyDraftValue) =>
      saveClarifyDraft({
        db: h.db,
        intermediaryNodeRunId: fixture.nodeRunId,
        roundId,
        questionId,
        value,
        editor,
        draftEvents: events,
      })
    // Chosen while still marked "decide later", and confirmed on that form.
    const stale = {
      selectedOptionIndices: [1],
      customText: '',
      decision: { status: 'deferred' as const, rationale: 'Keep this note' },
    }
    const confirmedBasis = clarifyAnswerBasis(questions[0]!, stale)
    await save('a', { ...stale, confirmedBasis })
    // Written while still marked "not applicable", with nothing else in the decision.
    await save('b', {
      selectedOptionIndices: [],
      customText: 'Five minutes',
      decision: { status: 'not-applicable' },
    })
    await save('c', {
      selectedOptionIndices: [],
      customText: '',
      decision: { status: 'not-applicable', rationale: 'Single node only' },
    })
    await save('d', {
      selectedOptionIndices: [0],
      customText: '',
      decision: { status: 'provisional', uncertainty: 'No baseline' },
    })

    const drafts = await fixture.drafts()
    expect(drafts.a).toEqual({
      selectedOptionIndices: [1],
      customText: '',
      decision: { rationale: 'Keep this note' },
      confirmedBasis,
    })
    // The stored answer is still the one that was confirmed.
    expect(
      isClarifyAnswerConfirmed(questions[0]!, {
        ...drafts.a!,
        questionId: 'a',
        selectedOptionLabels: [],
      }),
    ).toBe(true)
    expect(drafts.b).toEqual({ selectedOptionIndices: [], customText: 'Five minutes' })
    expect(drafts.b).not.toHaveProperty('decision')
    // A skip in effect and a maturity status are not touched.
    expect(drafts.c!.decision).toEqual({ status: 'not-applicable', rationale: 'Single node only' })
    expect(drafts.d!.decision).toEqual({ status: 'provisional', uncertainty: 'No baseline' })
    // Readers get the canonical form; they do not have to rule on it themselves.
    const snapshot = await createClarifyFollowupStore(h.db, taskExecutionParticipants, events).read(
      fixture.nodeRunId,
      'a',
    )
    expect(snapshot.drafts.a?.decision).toEqual({ rationale: 'Keep this note' })
    expect(snapshot.drafts.c?.decision?.status).toBe('not-applicable')
  })

  test('a sealed answer with a real choice loses the skip status on every seal path', async () => {
    const fixture = await seed(h, { questions: [question('a'), question('b'), question('c')] })
    const questions = await fixture.stored()
    const chosen = (
      questionId: string,
      status: 'deferred' | 'not-applicable',
      rationale?: string,
    ): ClarifyAnswer => ({ ...skip(questionId, status, rationale), selectedOptionIndices: [0] })

    // Per-question seal (the control channel).
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      answers: [chosen('a', 'not-applicable', 'Decided after all')],
    })
    expect((await fixture.answers())[0]).toEqual({
      questionId: 'a',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['A'],
      customText: '',
      decision: { rationale: 'Decided after all' },
    })

    // Re-answer of that sealed question: the declared overwrite goes through the same seal.
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      allowResealFor: ['a'],
      answers: [{ ...chosen('a', 'deferred'), selectedOptionIndices: [1] }],
    })
    const reanswered = (await fixture.answers()).find((answer) => answer.questionId === 'a')!
    expect(reanswered.selectedOptionLabels).toEqual(['B'])
    expect(reanswered).not.toHaveProperty('decision')

    // An index outside the options is dropped by the seal; what is left is a skip.
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      answers: [{ ...skip('b', 'deferred', 'Later'), selectedOptionIndices: [9] }],
    })
    expect((await fixture.answers()).find((answer) => answer.questionId === 'b')).toMatchObject({
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      decision: { status: 'deferred', rationale: 'Later' },
    })

    // Whole-round submit: confirmed on the form the client still held, sealed as the choice.
    const stale = chosen('c', 'deferred', 'Measured')
    const sealed = await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      wholeRound: true,
      questionSetKey: clarifyQuestionSetKey(questions),
      answers: [confirm(questions, stale)],
    })
    expect(sealed.roundFullySealed).toBe(true)
    const c = (await fixture.answers()).find((answer) => answer.questionId === 'c')!
    expect(c.decision).toEqual({ rationale: 'Measured' })
    expect(c.selectedOptionLabels).toEqual(['A'])
    expect(isClarifyAnswerConfirmed(questions[2]!, c)).toBe(true)
  })
})

describeEachProvider('RFC-490 §2.5 the question board shows a sealed skip', (h) => {
  test('a sealed skip reports its kind and note; other entries are as before', async () => {
    const fixture = await seed(h, {
      questions: [question('a'), question('b'), question('c'), question('d')],
    })
    const questions = await fixture.stored()
    const board = async () =>
      new Map(
        (await listTaskQuestions(h.db, taskExecutionParticipants, fixture.taskId)).map(
          (entry) => [entry.questionId, entry] as const,
        ),
      )

    // A skip that is only drafted is not an answer on the board yet.
    await saveClarifyDraft({
      db: h.db,
      intermediaryNodeRunId: fixture.nodeRunId,
      roundId: (await fixture.read()).id,
      questionId: 'b',
      value: { selectedOptionIndices: [], customText: '', decision: { status: 'deferred' } },
      editor,
      draftEvents: events,
    })
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      answers: [skip('a', 'not-applicable', '  No replica in the first release  ')],
    })
    const partial = await board()
    expect(partial.get('a')).toMatchObject({
      sealed: true,
      answerSkip: 'not-applicable',
      answerSummary: 'No replica in the first release',
    })
    expect(partial.get('b')).toMatchObject({ sealed: false, answerSummary: null })
    expect(partial.get('b')).not.toHaveProperty('answerSkip')

    const long = 'x'.repeat(260)
    await sealRoundQuestions({
      taskExecutionParticipants,
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      wholeRound: true,
      questionSetKey: clarifyQuestionSetKey(questions),
      answers: [
        confirm(questions, skip('b', 'deferred')),
        confirm(questions, {
          questionId: 'c',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
          decision: { status: 'decided', rationale: 'Not shown as the answer' },
        }),
        confirm(questions, skip('d', 'deferred', long)),
      ],
    })
    const full = await board()
    expect(full.get('a')).toMatchObject({
      answerSkip: 'not-applicable',
      answerSummary: 'No replica in the first release',
    })
    // No note: the skip itself is all there is to show.
    expect(full.get('b')).toMatchObject({ sealed: true, answerSkip: 'deferred' })
    expect(full.get('b')!.answerSummary).toBeNull()
    // A chosen answer keeps its label summary and is not a skip.
    expect(full.get('c')!.answerSummary).toBe('A')
    expect(full.get('c')).not.toHaveProperty('answerSkip')
    // The note is cut like any other summary.
    expect(full.get('d')).toMatchObject({
      answerSkip: 'deferred',
      answerSummary: `${'x'.repeat(200)}…`,
    })
  })
})

describe('RFC-490 C9: the MCP draft tool reaches the two skip statuses', () => {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === 'save_clarify_draft')!

  test('the tool accepts all four statuses and says what a skip does', () => {
    const decision = tool.inputSchema.decision!
    for (const status of ['decided', 'provisional', 'deferred', 'not-applicable'])
      expect(decision.safeParse({ status, rationale: 'Why' }).data).toEqual({
        status,
        rationale: 'Why',
      })
    expect(decision.safeParse({ status: 'skipped' }).success).toBe(false)
    expect(decision.safeParse(undefined).success).toBe(true)
    const schema = JSON.stringify(toInputJsonSchema(z.object(tool.inputSchema)))
    expect(schema).toContain('"enum":["decided","provisional","deferred","not-applicable"]')
    for (const text of ['"deferred"', '"not-applicable"', 'the skip status is dropped'])
      expect(decision.description).toContain(text)
  })
})
