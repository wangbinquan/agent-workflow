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
  CLARIFY_MINDMAP_QUESTION_GUIDANCE,
  type ClarifyMindmapConfig,
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
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/clarify/seal'
import {
  saveClarifyDraft,
  freezeAnswerAttributions,
} from '@/modules/collaboration/infrastructure/clarifyRounds'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createClarifyFollowupOperations } from '@/modules/collaboration/application/clarifyFollowup'
import { clarifyFollowupActivity } from '@/modules/collaboration/infrastructure/clarifyFollowupActivity'
import type {
  ClarifyFollowupGenerator,
  ClarifyFollowupStore,
} from '@/modules/collaboration/application/ports/clarifyFollowup'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const editor = { userId: 'fixture', displayName: 'Reviewer', role: 'owner' as const }
// The production composition shares one in-flight registry with the round seal.
const followups = (store: ClarifyFollowupStore, generator: ClarifyFollowupGenerator) =>
  createClarifyFollowupOperations(store, generator, clarifyFollowupActivity)
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
  // RFC-372 review follow-up O5: an unconfigured generator is unavailable, not a bad request.
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'clarify-followup-unavailable' })
})

async function seed(
  h: ProviderHarness,
  kind: 'self' | 'cross' = 'self',
  mindmap = true,
  config: ClarifyMindmapConfig = { categories: ['Scope'], instructions: 'Ask consequences' },
) {
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
              mindmap: config,
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
    test(`${kind}: nested category configuration reaches follow-up from the immutable task snapshot without focus notes`, async () => {
      const fixture = await seed(h, kind, true, {
        categories: ['Scope', ['Performance', 'Database', 'SQL']],
        instructions: '',
      })
      // Editing the reusable workflow must not silently change an already running task.
      await h.db.update(workflows).set({ definition: JSON.stringify({ nodes: [] }) })
      const store = createClarifyFollowupStore(h.db, events)
      const snapshot = await store.read(fixture.nodeRunId, [])
      expect(snapshot.categoryPaths).toEqual([['Scope'], ['Performance', 'Database', 'SQL']])
      expect(snapshot.instruction).toBe('')
      const operations = followups(store, {
        generate: async ({ prompt }) => {
          expect(prompt).toContain(CLARIFY_MINDMAP_QUESTION_GUIDANCE)
          // RFC-378 real follow-ups incorrectly forced compatible review
          // triggers into single-choice. The application used to exemplify
          // only "kind":"single"; both kinds and structured tradeoffs must
          // reach the actual generator, for both self and cross rounds.
          expect(prompt).toContain('"kind": "single"')
          expect(prompt).toContain('"kind": "multi"')
          expect(prompt).toContain('"recommendationReason"')
          expect(prompt).toContain(
            'start with problem priority, observable success and feasible evidence',
          )
          expect(prompt).toContain('Honor a specific tradeoff requested by the user')
          expect(prompt).toContain('Neither option decides any other mechanism')
          expect(prompt).toContain('A negative choice does not prescribe a replacement process')
          expect(prompt).toContain('渠道和时机另定')
          expect(prompt).toContain('其他措施未定')
          expect(prompt).toContain('已有记录（如有）')
          expect(prompt).toContain('按已约定的紧急程度')
          expect(prompt).toContain('otherwise use one category level')
          expect(prompt).toContain('Every question needs 2–4 options')
          expect(prompt).toContain(
            '"configuredCategoryPaths":[["Scope"],["Performance","Database","SQL"]]',
          )
          expect(prompt).toContain('"guidance":""')
          expect(prompt).toContain('"userRequest":""')
          return (
            '<workflow-clarify>' +
            JSON.stringify({
              questions: [
                { ...q('sql'), mindmap: { categoryPath: ['Performance', 'Database', 'SQL'] } },
              ],
            }) +
            '</workflow-clarify>'
          )
        },
      })
      await operations.append(
        fixture.nodeRunId,
        {
          requestId: randomUUID(),
          categoryPath: [],
          instruction: '',
          basis: clarifyContentKey(clarifyFollowupContext(snapshot.questions, snapshot.drafts, [])),
        },
        editor,
      )
      const questions = JSON.parse((await fixture.read()).questionsJson) as ClarifyQuestion[]
      expect(questions.at(-1)?.mindmap?.categoryPath).toEqual(['Performance', 'Database', 'SQL'])
      expect(questions.at(-1)?.mindmap?.parentQuestionId).toBeUndefined()
    })

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
      expect(snap.categoryPaths).toEqual([['Scope']])
      expect(snap.drafts.b?.confirmedBasis).toBe(answer(fixture.questions[1]!).confirmedBasis)
      let calls = 0
      const operations = followups(store, {
        generate: async (input) => {
          calls++
          expect(input.prompt).toContain(CLARIFY_MINDMAP_QUESTION_GUIDANCE)
          expect(input.prompt).toContain('Ask consequences')
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
        await followups(store, {
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
      const ops = followups(store, {
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
    const ops = followups(store, {
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
    const operations = followups(store, {
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

describeEachProvider(
  'RFC-372 category and root directions share the original append lifecycle',
  (h) => {
    for (const kind of ['self', 'cross'] as const)
      for (const categoryPath of [['Scope'], []])
        test(`${kind}: ${categoryPath.length ? 'category' : 'root'} directions append peers and preserve prior answers`, async () => {
          const fixture = await seed(h, kind)
          const store = createClarifyFollowupStore(h.db, events)
          await saveClarifyDraft({
            db: h.db,
            intermediaryNodeRunId: fixture.nodeRunId,
            roundId: (await fixture.read()).id,
            questionId: 'b',
            value: answer(fixture.questions[1]!),
            editor,
            draftEvents: events,
          })
          const snapshot = await store.read(fixture.nodeRunId, categoryPath)
          const context = clarifyFollowupContext(snapshot.questions, snapshot.drafts, categoryPath)
          let calls = 0
          const operations = followups(store, {
            generate: async ({ prompt }) => {
              calls++
              expect(prompt).toContain(JSON.stringify(context))
              expect(prompt).toContain('数据库性能')
              expect(prompt).toContain(JSON.stringify({ categoryPath }).slice(1, -1))
              return (
                '<workflow-clarify>' +
                JSON.stringify({
                  questions: [
                    { ...q('db'), mindmap: { categoryPath: ['Database'] } },
                    { ...q('capacity'), mindmap: { categoryPath: ['Capacity'] } },
                  ],
                }) +
                '</workflow-clarify>'
              )
            },
          })
          const request = {
            requestId: randomUUID(),
            categoryPath,
            instruction: '也考虑数据库性能',
            basis: clarifyContentKey(context),
          }
          const result = await operations.append(fixture.nodeRunId, request, editor)
          expect(await operations.append(fixture.nodeRunId, request, editor)).toEqual(result)
          expect(
            await followups(store, {
              generate: async () => {
                throw new Error('must replay')
              },
            }).append(fixture.nodeRunId, request, editor),
          ).toEqual(result)
          expect(calls).toBe(1)
          const row = await fixture.read()
          const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
          expect(questions.slice(0, 2)).toEqual(fixture.questions)
          expect(questions.slice(2).map((question) => question.mindmap?.categoryPath)).toEqual(
            categoryPath.length ? [['Scope'], ['Scope']] : [['Database'], ['Capacity']],
          )
          expect(
            questions
              .slice(2)
              .every((question) => question.mindmap?.parentQuestionId === undefined),
          ).toBe(true)
          expect(JSON.parse(row.draftAnswersJson!).b.confirmedBasis).toBe(
            answer(fixture.questions[1]!).confirmedBasis,
          )
          await expect(
            operations.append(
              fixture.nodeRunId,
              { ...request, categoryPath: ['Scope', 'unknown'] },
              editor,
            ),
          ).rejects.toThrow('not found')
          await expect(
            operations.append(fixture.nodeRunId, { ...request, instruction: 'other' }, editor),
          ).rejects.toThrow('request ID')
        })

    test('category generation rejects stale answers and cancellation, and honors partially/finally sealed branches', async () => {
      const fixture = await seed(h)
      const store = createClarifyFollowupStore(h.db, events)
      await sealRoundQuestions({
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        answers: [answer(fixture.questions[0]!)],
      })
      expect((await store.read(fixture.nodeRunId, ['Scope'])).canAppend).toBe(true)
      for (const effect of ['edit', 'cancel'] as const) {
        const snapshot = await store.read(fixture.nodeRunId, ['Scope'])
        let start!: () => void, finish!: () => void
        const started = new Promise<void>((resolve) => {
          start = resolve
        })
        const gate = new Promise<void>((resolve) => {
          finish = resolve
        })
        const ops = followups(store, {
          generate: async ({ prompt }) => {
            expect(prompt).toContain('selectedOptionIndices')
            start()
            await gate
            return generated
          },
        })
        const request = {
          requestId: randomUUID(),
          categoryPath: ['Scope'],
          instruction: '',
          basis: clarifyContentKey(
            clarifyFollowupContext(snapshot.questions, snapshot.drafts, ['Scope']),
          ),
        }
        const outcome = ops
          .append(fixture.nodeRunId, request, editor)
          .catch((error: unknown) => error)
        await started
        if (effect === 'edit')
          await saveClarifyDraft({
            db: h.db,
            intermediaryNodeRunId: fixture.nodeRunId,
            roundId: snapshot.roundId,
            questionId: 'b',
            value: { selectedOptionIndices: [1], customText: '' },
            editor,
            draftEvents: events,
          })
        else await ops.cancel(fixture.nodeRunId, request.requestId)
        finish()
        expect(await outcome).toMatchObject({
          code: effect === 'edit' ? 'clarify-followup-stale' : 'clarify-followup-canceled',
        })
        expect(JSON.parse((await fixture.read()).questionsJson)).toHaveLength(2)
      }
      await sealRoundQuestions({
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        answers: [answer(fixture.questions[1]!)],
      })
      for (const target of [[], ['Scope']])
        expect((await store.read(fixture.nodeRunId, target)).canAppend).toBe(false)
      await expect(store.read(fixture.nodeRunId, ['Scope extra'])).rejects.toThrow('not found')
      await expect(
        followups(store, { generate: async () => generated }).append(
          fixture.nodeRunId,
          { requestId: randomUUID(), categoryPath: ['Scope'], instruction: '', basis: 'stale' },
          editor,
        ),
      ).rejects.toThrow('no longer accepts')
    })
  },
)

describeEachProvider('RFC-378 decision persistence on the original round', (h) => {
  for (const kind of ['self', 'cross'] as const)
    test(`${kind}: notes survive drafts, branch context, partial seals and final seals`, async () => {
      const fixture = await seed(h, kind)
      const row = await fixture.read()
      const decision = {
        status: 'provisional' as const,
        rationale: 'No baseline',
        tradeoff: 'Accept conflicts',
        uncertainty: 'No-show rate unknown',
        validationOwner: 'Lin',
        revisitWhen: 'After one week',
      }
      const values = fixture.questions.map((question) => {
        const value = { ...answer(question), decision }
        return { ...value, confirmedBasis: clarifyAnswerBasis(question, value) }
      })
      for (const value of values)
        await saveClarifyDraft({
          db: h.db,
          intermediaryNodeRunId: fixture.nodeRunId,
          roundId: row.id,
          questionId: value.questionId,
          value,
          editor,
          draftEvents: events,
        })
      expect(JSON.parse((await fixture.read()).draftAnswersJson!).a.decision).toEqual(decision)
      const store = createClarifyFollowupStore(h.db, events)
      expect((await store.read(fixture.nodeRunId, 'b')).drafts.a?.decision).toEqual(decision)
      await sealRoundQuestions({
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        answers: [values[0]!],
      })
      expect((await store.read(fixture.nodeRunId, 'b')).drafts.a?.decision).toEqual(decision)
      const edited = { ...values[1]!, decision: { ...decision, tradeoff: 'New accepted cost' } }
      await expect(
        sealRoundQuestions({
          db: h.db,
          originNodeRunId: fixture.nodeRunId,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(fixture.questions),
          answers: [edited],
        }),
      ).rejects.toThrow('confirm')
      const final = { ...edited, confirmedBasis: clarifyAnswerBasis(fixture.questions[1]!, edited) }
      await sealRoundQuestions({
        db: h.db,
        originNodeRunId: fixture.nodeRunId,
        wholeRound: true,
        questionSetKey: clarifyQuestionSetKey(fixture.questions),
        answers: [final],
      })
      const sealed = JSON.parse((await fixture.read()).answersJson!) as ClarifyAnswer[]
      expect(sealed.find((value) => value.questionId === 'a')?.decision).toEqual(decision)
      expect(sealed.find((value) => value.questionId === 'b')?.decision).toEqual(final.decision)
    })
})

test('RFC-378 attribution changes when only the decision changes; normalized empty notes keep legacy authors', () => {
  const value = answer(q('a'))
  const original = { userId: 'editor', role: 'owner' as const, updatedAt: 1 }
  const freeze = (submitted: ClarifyAnswer, draft = value) =>
    freezeAnswerAttributions({
      answers: [submitted],
      draftAnswers: { a: draft },
      draftAttributions: { a: original },
      submitter: { userId: 'submitter', role: 'owner' },
      now: 2,
    }).a
  expect(freeze({ ...value, decision: { rationale: 'Added at submission' } })?.userId).toBe(
    'submitter',
  )
  expect(freeze({ ...value, decision: { rationale: '  ' } })).toEqual(original)
  const noted = { ...value, decision: { status: 'provisional' as const, uncertainty: 'Unknown' } }
  expect(freeze(noted, noted)).toEqual(original)
})

test('RFC-378 HTTP draft route forwards decision and confirmation without narrowing the payload', async () => {
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
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  let saved: unknown
  mountClarifyRoutes(app, {
    clarify: {
      saveDraft: async (args: unknown) => {
        saved = args
        return { roundId: 'round', questionId: 'a', updatedAt: 1 }
      },
    },
    access: {
      resolveClarifyTask: async () => ({
        roundExists: true,
        nodeRunExists: true,
        taskId: 'task',
        task: {},
        actorRole: 'owner',
        visible: true,
      }),
    },
  } as unknown as CollaborationRouteOperations)
  const decision = { status: 'decided', uncertainty: 'Still unverified', revisitWhen: 'Friday' }
  const response = await app.request('/api/clarify/gate/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roundId: 'round',
      questionId: 'a',
      selectedOptionIndices: [0],
      confirmedBasis: 'v2:confirmed',
      decision,
    }),
  })
  expect(response.status).toBe(200)
  expect(saved).toMatchObject({ value: { decision, confirmedBasis: 'v2:confirmed' } })
})
