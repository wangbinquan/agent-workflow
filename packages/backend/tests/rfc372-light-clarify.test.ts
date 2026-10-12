import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { mountClarifyRoutes } from '@/routes/clarify'
import type { CollaborationRouteOperations } from '@/modules/collaboration/public/participants'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyQuestionSetKey,
  effectiveClarifyAnswers,
  type ClarifyAnswer,
  type ClarifyFollowup,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { clarifyRounds, nodeRuns, tasks, workflows } from '@/db/schema'
import { createClarifyRound } from '@/services/clarify/service'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { saveClarifyDraft } from '@/modules/collaboration/infrastructure/clarifyRounds'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createClarifyFollowupOperations } from '@/modules/collaboration/application/clarifyFollowup'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const editor = { userId: 'fixture', displayName: 'Reviewer', role: 'owner' as const }
const events = { publish: async () => {} }
const q = (id: string, parentQuestionId?: string) =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['A', 'B'],
    mindmap: { categoryPath: ['Scope'], ...(parentQuestionId ? { parentQuestionId } : {}) },
  })
const answer = (question: ClarifyQuestion): ClarifyAnswer => {
  const a = {
    questionId: question.id,
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
  return { ...a, confirmedBasis: clarifyAnswerBasis(question, a) }
}
const generated =
  '<workflow-clarify>' + JSON.stringify({ questions: [q('new')] }) + '</workflow-clarify>'

test('a route composition without a follow-up generator returns a structured unavailable error', async () => {
  const app = new Hono()
  const actor = buildActor({
    user: {
      id: 'reviewer',
      username: 'reviewer',
      displayName: 'Reviewer',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
  let accessReads = 0
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  mountClarifyRoutes(app, {
    clarify: {},
    access: {
      async resolveClarifyTask() {
        accessReads++
        return {
          roundExists: true,
          nodeRunExists: true,
          taskId: 'task',
          task: {},
          actorRole: 'owner',
          visible: true,
        }
      },
    },
  } as unknown as CollaborationRouteOperations)
  const response = await app.request('/api/clarify/gate/followup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), parentQuestionId: 'q1', basis: 'v1:basis' }),
  })
  expect(accessReads).toBe(1)
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ code: 'clarify-followup-unavailable' })
})

async function seed(h: ProviderHarness, kind: 'self' | 'cross' = 'self', mindmap = true) {
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
        ...(mindmap
          ? {
              interactionMode: 'mindmap',
              mindmap: { categories: ['Scope'], instructions: 'Ask consequences' },
            }
          : {}),
      },
    ],
    edges: [],
    outputs: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'light',
    definition: JSON.stringify(definition),
    schemaVersion: 7,
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'light',
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc372',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await h.db
    .insert(nodeRuns)
    .values({ id: askingNodeRunId, taskId, nodeId: 'asking', status: 'done', iteration: 0 })
  const questions = [q('a'), q('b', 'a')]
  const common = {
    db: h.db,
    taskId,
    askingNodeId: 'asking',
    askingNodeRunId,
    intermediaryNodeId: 'gate',
    questions,
  }
  const round = await createClarifyRound(
    kind === 'self'
      ? { ...common, kind, askingShardKey: null, iteration: 0 }
      : { ...common, kind, targetConsumerNodeId: 'designer', loopIter: 0 },
  )
  const read = async () =>
    (
      await h.db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, round.intermediaryNodeRunId))
    )[0]!
  return { taskId, nodeRunId: round.intermediaryNodeRunId, questions, read }
}

describeEachProvider('RFC-372 original round and branch follow-up', (h) => {
  for (const kind of ['self', 'cross'] as const)
    test(`${kind}: persistent shared draft, append idempotency, old-tab rejection and original seal`, async () => {
      const fixture = await seed(h, kind),
        store = createClarifyFollowupStore(h.db, events)
      const save = async (question: ClarifyQuestion, value = answer(question)) =>
        saveClarifyDraft({
          db: h.db,
          intermediaryNodeRunId: fixture.nodeRunId,
          roundId: (await fixture.read()).id,
          questionId: question.id,
          value,
          editor,
          draftEvents: events,
        })
      for (const question of fixture.questions) await save(question)
      const snap = await store.read(fixture.nodeRunId, 'b')
      expect(snap.instruction).toBe('Ask consequences')
      expect(snap.drafts.b?.confirmedBasis).toBe(answer(fixture.questions[1]!).confirmedBasis)
      let calls = 0
      const operations = createClarifyFollowupOperations(store, {
        generate: async (input) => {
          calls++
          expect(input.prompt).toContain('Question a')
          expect(input.prompt).toContain('Question b')
          return generated
        },
      })
      const request: ClarifyFollowup = {
        requestId: randomUUID(),
        parentQuestionId: 'b',
        instruction: 'Deeper',
        basis: clarifyContentKey(clarifyFollowupContext(snap.questions, snap.drafts, 'b')),
      }
      const beforeRuns = await h.db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, fixture.taskId))
      const appended = await operations.append(fixture.nodeRunId, request, editor)
      expect(await operations.append(fixture.nodeRunId, request, editor)).toEqual(appended)
      // Retry after process restart recovers from the same original questions JSON.
      expect(
        await createClarifyFollowupOperations(store, {
          generate: async () => {
            throw new Error('must not regenerate')
          },
        }).append(fixture.nodeRunId, request, editor),
      ).toEqual(appended)
      expect(calls).toBe(1)
      await expect(
        operations.append(fixture.nodeRunId, { ...request, instruction: 'different' }, editor),
      ).rejects.toThrow('request ID')
      const row = await fixture.read(),
        qs = JSON.parse(row.questionsJson) as ClarifyQuestion[]
      expect(qs).toHaveLength(3)
      expect(qs[2]?.mindmap).toMatchObject({
        categoryPath: ['Scope'],
        parentQuestionId: 'b',
        requestId: request.requestId,
      })
      expect(row.iteration).toBe(0)
      expect(row.status).toBe('awaiting_human')
      expect(await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, fixture.taskId))).toEqual(
        beforeRuns,
      )
      await expect(
        sealRoundQuestions({
          db: h.db,
          originNodeRunId: fixture.nodeRunId,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(fixture.questions),
          answers: fixture.questions.map(answer),
        }),
      ).rejects.toThrow('Questions changed')
      await expect(
        sealRoundQuestions({
          db: h.db,
          originNodeRunId: fixture.nodeRunId,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(qs),
          answers: fixture.questions.map(answer),
        }),
      ).rejects.toThrow('confirm')
      const sealed = await sealRoundQuestions({
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        wholeRound: true,
        questionSetKey: clarifyQuestionSetKey(qs),
        answers: qs.map(answer),
      })
      expect(sealed.roundFullySealed).toBe(true)
      expect(JSON.parse((await fixture.read()).answersJson!)).toHaveLength(3)
    })
  test('late generation is rejected after ancestor edit, cancellation, or whole-round submission; failure is retryable', async () => {
    const fixture = await seed(h),
      store = createClarifyFollowupStore(h.db, events)
    const makeRequest = async (): Promise<ClarifyFollowup> => {
      const snap = await store.read(fixture.nodeRunId, 'b')
      return {
        requestId: randomUUID(),
        parentQuestionId: 'b',
        instruction: '',
        basis: clarifyContentKey(clarifyFollowupContext(snap.questions, snap.drafts, 'b')),
      }
    }
    for (const effect of ['edit', 'cancel', 'cancel-reject', 'submit', 'failure'] as const) {
      if (effect === 'failure') continue // Failure recovery has its own open round below.
      let release!: () => void, started!: () => void
      const start = new Promise<void>((resolve) => {
        started = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const ops = createClarifyFollowupOperations(store, {
        generate: async ({ signal }) => {
          started()
          await gate
          if (effect === 'cancel-reject' && signal.aborted) throw new Error('native CLI aborted')
          return generated
        },
      })
      const request = await makeRequest()
      const pending = ops.append(fixture.nodeRunId, request, editor)
      const outcome = pending.then(
        () => null,
        (error) => error as Error,
      )
      await start
      if (effect === 'edit')
        await saveClarifyDraft({
          db: h.db,
          intermediaryNodeRunId: fixture.nodeRunId,
          roundId: (await fixture.read()).id,
          questionId: 'a',
          value: { selectedOptionIndices: [1], customText: '' },
          editor,
          draftEvents: events,
        })
      if (effect === 'cancel' || effect === 'cancel-reject')
        await ops.cancel(fixture.nodeRunId, request.requestId)
      if (effect === 'submit') {
        // The centralized/deferred route calls the same seal without wholeRound.
        await expect(
          sealRoundQuestions({
            db: h.db,
            originNodeRunId: fixture.nodeRunId,
            answers: fixture.questions.map(answer),
          }),
        ).rejects.toThrow('cancel')
        await expect(
          sealRoundQuestions({
            db: h.db,
            originNodeRunId: fixture.nodeRunId,
            wholeRound: true,
            questionSetKey: clarifyQuestionSetKey(fixture.questions),
            answers: fixture.questions.map(answer),
          }),
        ).rejects.toThrow('cancel')
        await ops.cancel(fixture.nodeRunId, request.requestId)
        await sealRoundQuestions({
          db: h.db,
          originNodeRunId: fixture.nodeRunId,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(fixture.questions),
          answers: fixture.questions.map(answer),
        })
      }
      release()
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      if (effect === 'cancel-reject')
        expect(error).toMatchObject({ code: 'clarify-followup-canceled', status: 409 })
      expect(JSON.parse((await fixture.read()).questionsJson)).toHaveLength(2)
    }
    const other = await seed(h)
    const snap = await store.read(other.nodeRunId, 'b')
    let attempts = 0
    const ops = createClarifyFollowupOperations(store, {
      generate: async () => {
        if (++attempts === 1) throw new Error('unavailable')
        return generated
      },
    })
    const request = {
      requestId: randomUUID(),
      parentQuestionId: 'b',
      instruction: '',
      basis: clarifyContentKey(clarifyFollowupContext(snap.questions, snap.drafts, 'b')),
    }
    await expect(ops.append(other.nodeRunId, request, editor)).rejects.toThrow('unavailable')
    expect((await ops.append(other.nodeRunId, request, editor)).questionIds).toHaveLength(1)
  })
  test('a sealed ancestor uses its final answer in follow-up context while its child stays open', async () => {
    const fixture = await seed(h)
    const final = { ...answer(fixture.questions[0]!), selectedOptionIndices: [1], customText: '' }
    await saveClarifyDraft({
      db: h.db,
      intermediaryNodeRunId: fixture.nodeRunId,
      roundId: (await fixture.read()).id,
      questionId: 'a',
      value: answer(fixture.questions[0]!),
      editor,
      draftEvents: events,
    })
    await sealRoundQuestions({ db: h.db, originNodeRunId: fixture.nodeRunId, answers: [final] })
    const store = createClarifyFollowupStore(h.db, events)
    const snapshot = await store.read(fixture.nodeRunId, 'b')
    expect(snapshot.canAppend).toBe(true)
    expect(snapshot.drafts.a?.selectedOptionIndices).toEqual([1])
    const client = effectiveClarifyAnswers({ a: answer(fixture.questions[0]!) }, [final])
    const context = clarifyFollowupContext(fixture.questions, client, 'b')
    const operations = createClarifyFollowupOperations(store, {
      generate: async ({ prompt }) => {
        expect(prompt).toContain(JSON.stringify(context))
        return generated
      },
    })
    await operations.append(
      fixture.nodeRunId,
      {
        requestId: randomUUID(),
        parentQuestionId: 'b',
        instruction: '',
        basis: clarifyContentKey(context),
      },
      editor,
    )
    expect(JSON.parse((await fixture.read()).questionsJson)).toHaveLength(3)
  })
  test('ordinary rounds strip metadata and retain original unconfirmed seal; locked answers remain intact', async () => {
    const plain = await seed(h, 'self', false)
    expect(
      JSON.parse((await plain.read()).questionsJson).every(
        (question: ClarifyQuestion) => !question.mindmap,
      ),
    ).toBe(true)
    await expect(
      createClarifyFollowupStore(h.db, events).read(plain.nodeRunId, 'a'),
    ).rejects.toThrow('mindmap mode')
    expect(
      (
        await sealRoundQuestions({
          db: h.db,
          originNodeRunId: plain.nodeRunId,
          answers: plain.questions.map((question) => ({
            ...answer(question),
            confirmedBasis: undefined,
          })),
        })
      ).roundFullySealed,
    ).toBe(true)
    const map = await seed(h)
    await sealRoundQuestions({
      db: h.db,
      originNodeRunId: map.nodeRunId,
      answers: [answer(map.questions[0]!)],
    })
    expect(
      (await createClarifyFollowupStore(h.db, events).read(map.nodeRunId, 'a')).canAppend,
    ).toBe(false)
    expect(
      (
        await sealRoundQuestions({
          db: h.db,
          originNodeRunId: map.nodeRunId,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(map.questions),
          answers: [answer(map.questions[1]!)],
        })
      ).roundFullySealed,
    ).toBe(true)
    expect(JSON.parse((await map.read()).answersJson!)[0].selectedOptionIndices).toEqual([0])
  })
})
