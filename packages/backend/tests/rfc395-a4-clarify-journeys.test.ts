import { decomposeClarifyRound } from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { roundRow } from './helpers/rfc395V2/collabFixtures'
import { fixtureContentStore } from './helpers/model/content'
// RFC-395 II-a A4: both providers must preserve draft/seal/follow-up journeys and distillation bytes through the new ports.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ClarifyQuestionSchema,
  ClarifyAnswerSchema,
  DEFAULT_SOURCE_CONTEXT_BUDGET,
  clarifyAnswerBasis,
  clarifyQuestionSetKey,
  clarifyContentKey,
  clarifyFollowupContext,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifyFollowup,
  type TaskActorRole,
} from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { headClarifyReaders } from './helpers/rfc395A4HeadReaders'
import {
  clarifyRoundFixture,
  nodeRunFixture,
  taskFixture,
  workflowFixture,
  readClarifyRoundFixtures,
  patchClarifyRoundFixture,
} from './helpers/model'
import {
  saveClarifyDraft,
  getClarifyRoundDetail,
} from '@/modules/collaboration/infrastructure/clarifyRounds'
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/clarify/seal'
import { listTaskQuestions } from '@/modules/collaboration/infrastructure/taskQuestions'
import { createClarifyRepairParticipant } from '@/modules/collaboration/infrastructure/clarifyRepairParticipant'
import { createHumanGateTerminalSweepCommand } from '@/modules/collaboration/infrastructure/humanGateTerminalSweep'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createCommittedHumanInputQueries } from '@/modules/collaboration/infrastructure/committedHumanInputQueries'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'
import { createSqliteMemoryDistillTestContext } from './helpers/memoryDistill'
import {
  buildDistillerUserPrompt,
  loadSourceEvents,
  rowToDistillJob,
} from '@/modules/memory/application/distill/memoryDistiller'

const editorA = { userId: 'a4-owner', displayName: 'Owner', role: 'owner' as const }
const editorB = { userId: 'a4-member', displayName: 'Member', role: 'user' as const }
const events = { publish: async () => {} }
const question = (id: string, mindmap = false) =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['A', 'B'],
    ...(mindmap ? { mindmap: { categoryPath: ['Scope'] } } : {}),
  })
const answer = (q: ClarifyQuestion, text = ''): ClarifyAnswer => {
  const value = {
    questionId: q.id,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: text,
  }
  return { ...value, ...(q.mindmap ? { confirmedBasis: clarifyAnswerBasis(q, value) } : {}) }
}

async function seed(
  db: PersistenceDb,
  kind: 'self' | 'cross' = 'self',
  mindmap = false,
  id: string = randomUUID(),
) {
  const taskId = randomUUID(),
    origin = randomUUID(),
    source = randomUUID(),
    workflowId = randomUUID()
  const definition = {
    $schema_version: 7,
    inputs: [],
    outputs: [],
    nodes: [
      { id: 'asking', kind: 'agent-single', agentName: 'asking' },
      {
        id: 'gate',
        kind: kind === 'self' ? 'clarify' : 'clarify-cross-agent',
        ...(mindmap
          ? {
              interactionMode: 'mindmap',
              mindmap: { categories: ['Scope'], instructions: 'Consequences' },
            }
          : {}),
      },
    ],
    edges: [],
  }
  await workflowFixture(db, { id: workflowId, name: workflowId, definition, schemaVersion: 7 })
  await taskFixture(db, {
    id: taskId,
    name: 'clarify',
    workflowId,
    workflowSnapshot: definition,
    repoPath: '/tmp/a4',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  await nodeRunFixture(db, { id: source, taskId, nodeId: 'asking', status: 'done' })
  await nodeRunFixture(db, { id: origin, taskId, nodeId: 'gate', status: 'awaiting_human' })
  const questions = [question('a', mindmap), question('b', mindmap)]
  await clarifyRoundFixture(db, {
    id,
    taskId,
    kind,
    askingNodeId: 'asking',
    askingNodeRunId: source,
    intermediaryNodeId: 'gate',
    intermediaryNodeRunId: origin,
    iteration: 0,
    questions,
    status: 'awaiting_human',
    createdAt: 1,
  })
  const read = async () => (await readClarifyRoundFixtures(db, { id }))[0]!
  const save = (
    q: ClarifyQuestion,
    editor: { userId: string; displayName: string; role: TaskActorRole } = editorA,
    value = answer(q),
  ) =>
    saveClarifyDraft({
      db,
      roundId: id,
      intermediaryNodeRunId: origin,
      questionId: q.id,
      value,
      editor,
      draftEvents: events,
    })
  return { id, taskId, origin, questions, read, save }
}

describeEachProvider('RFC-395 II-a A4 clarify write port', (h) => {
  for (const draftKind of ['absent', 'empty', 'populated'] as const) {
    for (const attributionKind of ['absent', 'empty', 'populated'] as const) {
      test(`draft save preserves target state: ${draftKind} / ${attributionKind}`, async () => {
        const f = await seed(h.db)
        const priorDrafts =
          draftKind === 'populated' ? { b: answer(f.questions[1]!, 'retained') } : {}
        const priorAttributions =
          attributionKind === 'populated'
            ? { b: { userId: editorB.userId, role: editorB.role, updatedAt: 10 } }
            : {}
        const draftAnswers = draftKind === 'absent' ? null : JSON.stringify(priorDrafts)
        const answerAttributions =
          attributionKind === 'absent' ? null : JSON.stringify(priorAttributions)
        await patchClarifyRoundFixture(h.db, { id: f.id }, { draftAnswers, answerAttributions })
        expect(await f.read()).toMatchObject({
          draftAnswers,
          answerAttributions,
          draftsRecorded: draftKind !== 'absent',
          attributionsRecorded: attributionKind !== 'absent',
        })
        const saved = await f.save(f.questions[0]!)
        const row = await f.read()
        expect(JSON.parse(row.draftAnswers!)).toEqual({
          ...priorDrafts,
          a: answer(f.questions[0]!),
        })
        expect(JSON.parse(row.answerAttributions!)).toEqual({
          ...priorAttributions,
          a: { userId: editorA.userId, role: editorA.role, updatedAt: saved.updatedAt },
        })
        expect(row.answers).toBeNull()
      })
    }
  }

  test('committed human inputs retain HEAD strict JSON and Zod parsing for every status', async () => {
    const f = await seed(h.db)
    const queries = createCommittedHumanInputQueries({
      db: h.db,
      content: fixtureContentStore(h.db, '/unused-a4'),
    })
    const headAnswers = new Function(
      'row',
      'z',
      'ClarifyAnswerSchema',
      `return (${headClarifyReaders.committed.source})`,
    ) as (
      row: { status: string; answersJson: string | null },
      zod: typeof z,
      schema: typeof ClarifyAnswerSchema,
    ) => unknown
    const capture = async (run: () => unknown) => {
      try {
        return { value: await run() }
      } catch (error) {
        if (error instanceof z.ZodError) return { error: error.name, issues: error.issues }
        if (error instanceof Error) return { error: error.name, message: error.message }
        throw error
      }
    }
    const valid = answer(f.questions[0]!)
    for (const status of ['awaiting_human', 'answered', 'canceled', 'abandoned'] as const) {
      for (const answers of [
        null,
        '',
        '{broken',
        'null',
        '{}',
        'false',
        '0',
        '"legacy"',
        '[]',
        JSON.stringify([valid, { ...valid, customText: 'last' }]),
      ]) {
        await patchClarifyRoundFixture(
          h.db,
          { id: f.id }, // RFC-395 II-a: HEAD permits abandoned only for cross rounds, canceled only for self.
          { status, answers, kind: status === 'abandoned' ? 'cross' : 'self' },
        )
        expect(
          await capture(async () => (await queries.clarificationRounds(f.taskId))[0]!.answers),
        ).toEqual(
          await capture(() =>
            headAnswers({ status, answersJson: answers }, z, ClarifyAnswerSchema),
          ),
        )
      }
    }
  })

  test('two users save different questions; partial seal and full proxy seal preserve exact maps / seal order', async () => {
    const f = await seed(h.db)
    await Promise.all([f.save(f.questions[0]!, editorA), f.save(f.questions[1]!, editorB)])
    const drafted = await f.read()
    const draftMap = JSON.parse(drafted.draftAnswers!)
    const attrs = JSON.parse(drafted.answerAttributions!)
    expect(draftMap).toEqual({ a: answer(f.questions[0]!), b: answer(f.questions[1]!) })
    expect(attrs.a).toEqual({
      userId: editorA.userId,
      role: editorA.role,
      updatedAt: attrs.a.updatedAt,
    })
    expect(attrs.b.userId).toBe(editorB.userId)
    const partial = await sealRoundQuestions({
      db: h.db,
      originNodeRunId: f.origin,
      answers: [answer(f.questions[1]!)],
      sealedBy: editorA.userId,
      sealedByRole: editorA.role,
      directive: 'stop',
      now: () => 10,
    })
    expect(partial.roundFullySealed).toBe(false)
    const part = await f.read()
    expect(part.status).toBe('awaiting_human')
    expect(part.directive).toBeNull()
    expect(part.draftAnswers).toBe(drafted.draftAnswers)
    expect(part.answerAttributions).toBe(drafted.answerAttributions)
    const board = await listTaskQuestions(h.db, f.taskId)
    expect(board.find((row) => row.questionId === 'b')?.answerSummary).toBe('A')
    expect(board.find((row) => row.questionId === 'a')?.answerSummary).toBeNull()
    const full = await sealRoundQuestions({
      db: h.db,
      originNodeRunId: f.origin,
      answers: [answer(f.questions[0]!, 'proxy edit')],
      sealedBy: editorA.userId,
      sealedByRole: editorA.role,
      now: () => 20,
    })
    expect(full.roundFullySealed).toBe(true)
    const row = await f.read()
    expect(row.answers).toBe(
      JSON.stringify([answer(f.questions[1]!), answer(f.questions[0]!, 'proxy edit')]),
    )
    expect(row.draftAnswers).toBeNull()
    expect(row.answerAttributions).toBe(
      JSON.stringify({
        b: attrs.b,
        a: { userId: editorA.userId, role: editorA.role, updatedAt: 20 },
      }),
    )
    expect(row.submittedByRole).toBe('owner')
    const detail = await getClarifyRoundDetail(h.db, f.origin)
    expect(detail.answers).toEqual(JSON.parse(row.answers!))
    expect(detail.answerAttributions).toEqual(JSON.parse(row.answerAttributions!))
    await expect(f.save(f.questions[0]!)).rejects.toMatchObject({
      code: 'clarify-round-not-awaiting',
    })
  })

  test('re-answer keeps final attribution / submit facts; reopen preserves drafts and sealed ledger markers', async () => {
    const f = await seed(h.db)
    await sealRoundQuestions({
      db: h.db,
      originNodeRunId: f.origin,
      answers: f.questions.map((q) => answer(q)),
      sealedBy: editorA.userId,
      sealedByRole: editorA.role,
      directive: 'stop',
      now: () => 30,
    })
    const before = await f.read()
    const reseal = await sealRoundQuestions({
      db: h.db,
      originNodeRunId: f.origin,
      answers: [answer(f.questions[0]!, 'new')],
      allowResealFor: ['a'],
      sealedBy: editorB.userId,
      sealedByRole: editorB.role,
      directive: 'continue',
      now: () => 40,
    })
    expect(reseal.resealedQuestionIds).toEqual(['a'])
    const after = await f.read()
    expect(after.answerAttributions).toBe(before.answerAttributions)
    expect(after.answeredAt).toBe(30)
    expect(after.answeredBy).toBe(editorA.userId)
    expect(after.directive).toBe('stop')
    await patchClarifyRoundFixture(
      h.db,
      { id: f.id },
      { draftAnswers: { a: answer(f.questions[0]!, 'retained historical draft') } },
    )
    const drafted = await f.read()
    expect(
      await createClarifyRepairParticipant(h.db).reopen({
        taskId: f.taskId,
        roundId: f.id,
        expectedStatus: 'answered',
        occurredAt: 50,
      }),
    ).toBe(true)
    const reopened = await f.read()
    expect(reopened.answers).toBeNull()
    expect(reopened.answeredAt).toBeNull()
    expect(reopened.answeredBy).toBe(editorA.userId)
    expect(reopened.answerAttributions).toBe(before.answerAttributions)
    expect(reopened.draftAnswers).toBe(drafted.draftAnswers)
    expect((await listTaskQuestions(h.db, f.taskId)).every((entry) => entry.sealed)).toBe(true)
    expect(
      await createClarifyRepairParticipant(h.db).reopen({
        taskId: f.taskId,
        roundId: f.id,
        expectedStatus: 'answered',
        occurredAt: 50,
      }),
    ).toBe(false)
  })

  for (const kind of ['self', 'cross'] as const)
    test(`${kind} terminal sweep retains all drafts and attributions`, async () => {
      const f = await seed(h.db, kind)
      await f.save(f.questions[0]!)
      const before = await f.read()
      await createHumanGateTerminalSweepCommand(h.db).run({
        taskId: f.taskId,
        cause: 'task-done',
        now: 50,
      })
      const after = await f.read()
      expect(after.status).toBe(kind === 'self' ? 'canceled' : 'abandoned')
      expect(after.draftAnswers).toBe(before.draftAnswers)
      expect(after.answerAttributions).toBe(before.answerAttributions)
      expect(after.answers).toBe(before.answers)
      expect(after.abandonedAt).toBe(kind === 'cross' ? 50 : null)
    })

  test('follow-up appends without changing old questions or drafts; idempotency and stale seal remain unchanged', async () => {
    const f = await seed(h.db, 'self', true)
    await f.save(f.questions[0]!)
    const store = createClarifyFollowupStore(h.db, events)
    const current = await store.read(f.origin, 'a')
    const request: ClarifyFollowup = {
      requestId: 'a4-followup',
      parentQuestionId: 'a',
      instruction: '',
      basis: clarifyContentKey(clarifyFollowupContext(current.questions, current.drafts, 'a')),
    }
    const added = {
      ...question('c', true),
      mindmap: {
        categoryPath: ['Scope'],
        parentQuestionId: 'a',
        requestId: request.requestId,
        requestBasis: clarifyContentKey(request),
      },
    }
    const before = await f.read()
    await Promise.all([
      store.append(f.origin, request, [added], new AbortController().signal, editorA),
      f.save(f.questions[1]!, editorB),
    ])
    const row = await f.read()
    expect(JSON.parse(row.questions)).toEqual([...f.questions, added])
    expect(JSON.parse(row.draftAnswers!).a).toEqual(JSON.parse(before.draftAnswers!).a)
    expect(JSON.parse(row.draftAnswers!).b).toEqual(answer(f.questions[1]!))
    await store.append(f.origin, request, [added], new AbortController().signal, editorA)
    expect((await f.read()).questions).toBe(row.questions)
    await expect(
      sealRoundQuestions({
        db: h.db,
        originNodeRunId: f.origin,
        wholeRound: true,
        questionSetKey: clarifyQuestionSetKey(f.questions),
        answers: f.questions.map((q) => answer(q)),
      }),
    ).rejects.toMatchObject({ code: 'clarify-question-set-changed' })
    const qs = JSON.parse(row.questions) as ClarifyQuestion[]
    await f.save(added, editorB)
    expect(
      (
        await sealRoundQuestions({
          db: h.db,
          originNodeRunId: f.origin,
          wholeRound: true,
          questionSetKey: clarifyQuestionSetKey(qs),
          answers: qs.map((q) => answer(q)),
        })
      ).roundFullySealed,
    ).toBe(true)
    await expect(
      store.append(
        f.origin,
        { ...request, requestId: 'closed' },
        [question('d', true)],
        new AbortController().signal,
        editorA,
      ),
    ).rejects.toMatchObject({ code: 'clarify-followup-closed' })
  })

  test('memory preserves per-round prompt text and uses deterministic byte order for batch sections', async () => {
    // Insert in the opposite order and use >= 3 self IDs: HEAD's SQLite plan
    // could group by status/insertion instead of ID for a multi-round batch.
    const second = await seed(h.db, 'self', false, 'a4-order-a'),
      first = await seed(h.db, 'self', false, 'a4-order-Z'),
      third = await seed(h.db, 'self', false, 'a4-order-0'),
      cross = await seed(h.db, 'cross')
    const raw =
      ' [ ' +
      JSON.stringify(answer(first.questions[1]!, '中文')) +
      ', ' +
      JSON.stringify(answer(first.questions[0]!)) +
      ', ' +
      JSON.stringify(answer(first.questions[1]!, 'duplicate')) +
      ' ] '
    await patchClarifyRoundFixture(h.db, { id: first.id }, { answers: raw })
    await patchClarifyRoundFixture(h.db, { id: second.id }, { answers: [] })
    await patchClarifyRoundFixture(h.db, { id: third.id }, { answers: [] })
    const ids = [second.id, first.id, cross.id, third.id]
    const sources = await createClarifyAnswerQueries(h.db).listSelfSources(ids)
    expect(sources.map((row) => row.id)).toEqual(['a4-order-0', 'a4-order-Z', 'a4-order-a'])
    expect(sources.every((row) => !('answersJson' in row))).toBe(true)
    expect(await createClarifyAnswerQueries(h.db).listSelfQuestions(ids)).toEqual(
      [third, first, second].map((fixture) => ({
        id: fixture.id,
        taskId: fixture.taskId,
        questionsJson: JSON.stringify(fixture.questions),
      })),
    )
    const memory = createSqliteMemoryDistillTestContext(h.db)
    expect(await memory.store.listClarifySources(ids)).toEqual(sources)
    const jobs = sources.map((row) =>
      rowToDistillJob({
        id: randomUUID(),
        debounceKey: 'a4',
        sourceKind: 'clarify',
        sourceEventId: row.id,
        taskId: row.taskId,
        scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
        status: 'pending',
        attempts: 0,
        nextRunAt: 1,
        lastError: null,
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
      }),
    )
    const budget = {
      ...DEFAULT_SOURCE_CONTEXT_BUDGET,
      clarifyTranscriptMaxBytes: 0,
      reviewBodyMaxBytes: 0,
    }
    const loaded = await loadSourceEvents(
      memory.store,
      memory.reviewedArtifacts,
      jobs,
      memory.nodeRunPrompts,
      budget,
    )
    const expected = {
      ...loaded,
      clarify: [third, first, second].map((fixture) => ({
        id: fixture.id,
        taskId: fixture.taskId,
        nodeId: 'gate',
        sourceTranscriptMd: null,
        sourceTranscriptReason: 'disabled by config',
        questions: JSON.stringify(fixture.questions),
        answers: fixture.id === first.id ? raw : '[]',
      })),
    }
    const prompt = (events: typeof loaded) =>
      buildDistillerUserPrompt({
        events,
        scopeContexts: [],
        taskId: null,
        sourceContextBudget: budget,
      })
    expect(prompt(loaded)).toBe(prompt(expected))
  })
})

// Unrepresentable source arrays and invalid map bytes are converter inputs, never target fixtures.
test('source clarify arrays without keys block; invalid maps retain explicit conversion decisions', () => {
  const convert = (overrides: Record<string, string | null>) => {
    const values = {
      ...roundRow('legacy', 'task'),
      container_run_id: null,
      status: 'awaiting_human',
      ...overrides,
    }
    const key = [canonicalValue('legacy')]
    const row: SourceRow = {
      table: 'clarify_rounds',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('clarify_rounds', key),
      canonical: { key, values: Object.values(values).map(canonicalValue) },
      values,
    }
    return decomposeClarifyRound(
      row,
      {
        runId: 'task-run',
        taskId: 'task',
        containerRunId: null,
        scopePath: '',
        iteration: 0,
        quality: 'recorded',
      },
      'executable',
    )
  }
  for (const answers_json of ['[{}]', '[null]']) {
    const result = convert({ answers_json })
    expect(result.representable).toBe(false)
    expect(result.blocks.map((block) => block.code)).toEqual(['v2-clarify-answer-key'])
    expect(result.answers).toEqual([])
  }
  for (const column of ['draft_answers_json', 'answer_attributions_json']) {
    for (const raw of ['[]', '{broken']) {
      const result = convert({ [column]: raw })
      expect(result.blocks).toEqual([])
      expect(result.decisions).toContainEqual({
        code: 'v2-clarify-legacy-shape',
        detail: { column, evidence: 'source-journal', projection: 'legacy-decoder' },
      })
      expect(
        result.round[column === 'draft_answers_json' ? 'drafts_recorded' : 'attributions_recorded'],
      ).toBe(false)
      expect(result.drafts).toEqual([])
      expect(result.attributions).toEqual([])
    }
  }
})
