// RFC-395 V2-C phase 2: lossless attribution/legacy answers and D4 codec takeover outcomes.
import { expect, test } from 'bun:test'
import { clarifyQuestionSetKey } from '@agent-workflow/shared'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  answer,
  question,
  seedCollabTask,
  roundRow,
  readFixtureRows,
  convertFixtures,
  taskClasses,
} from './helpers/rfc395V2/collabFixtures'
import {
  clarifyRule,
  projectConvertedClarifyAnswers,
} from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { projectClarifyAnswers } from '@/modules/collaboration/domain/clarifyAnswers'
import { clarifyAnswerContentForPrompt } from '@/modules/collaboration/domain/clarifyAnswerContent'
import { decodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const conversion = { rules: [clarifyRule], lookups: [], validators: [] }

describeV2Providers('RFC-395 V2-C clarify', (h) => {
  test('NULL versus empty answers and drafts survive projection, with revision and sealed question key', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h)
    await h.write('clarify_rounds', [
      roundRow('null'),
      roundRow('empty', 'task', { answers_json: '[]', draft_answers_json: '{}' }),
    ])
    const source = await readFixtureRows(h, 'clarify_rounds')
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.status).toBe('converted')
    expect(dispositions).toEqual([])
    for (const row of source) {
      const round = sink.rows('clarify_rounds').find((r) => r.id === row.values.id)!
      expect(round.questions_revision).toBe(1)
      expect(round.sealed_question_set_key).toBe(clarifyQuestionSetKey([question()]))
      const sourceProjection = projectClarifyAnswers(
        decodeLegacyClarifyAnswerColumns({
          answersJson: row.values.answers_json as string | null,
          draftAnswersJson: row.values.draft_answers_json as string | null,
        }).state,
      )
      const replay = projectConvertedClarifyAnswers(round, [], [], [])
      expect(replay.answers).toEqual(sourceProjection.answers)
      expect(replay.draftAnswers).toEqual(sourceProjection.draftAnswers)
      expect(replay.answerAttributions).toEqual(sourceProjection.answerAttributions)
    }
    expect(sink.rows('clarify_rounds').find((r) => r.id === 'null')).toMatchObject({
      answers_recorded: false,
      drafts_recorded: false,
    })
    expect(sink.rows('clarify_rounds').find((r) => r.id === 'empty')).toMatchObject({
      answers_recorded: true,
      drafts_recorded: true,
    })
  }, 180_000)

  test('duplicate occurrences, orphan keys, draft text order and first/last answer projections are retained', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h)
    const answers = [answer('q', 'first'), answer('orphan'), answer('q', 'last')]
    await h.write('clarify_rounds', [
      roundRow('duplicates', 'task', {
        questions_json: JSON.stringify([question(), question()]),
        answers_json: JSON.stringify(answers),
        draft_answers_json:
          '{"10":{"customText":"old"},"2":{"customText":"two"},"10":{"customText":"last"}}',
        answer_attributions_json: '{ "q": { "userId":"editor","role":"owner","updatedAt":101 } }',
      }),
    ])
    const source = (await readFixtureRows(h, 'clarify_rounds'))[0]!
    const { summary, sink, dispositions, units } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.status).toBe('converted')
    const converted = sink.rows('clarify_answers')
    expect(
      converted
        .filter((r) => r.question_id === 'q')
        .map((r) => r.occurrence)
        .sort(),
    ).toEqual([0, 1])
    expect(converted.every((r) => r.updated_at === 120 && r.questions_revision === 1)).toBe(true)
    expect(converted.every((r) => !Object.hasOwn(r, 'attribution_json'))).toBe(true)
    expect(
      sink.rows('clarify_answer_drafts').every((r) => !Object.hasOwn(r, 'editor_attribution_json')),
    ).toBe(true)
    expect(
      sink
        .rows('clarify_answer_drafts')
        .map((r) => [r.question_id, r.ordinal, r.occurrence])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      ['10', 0, 0],
      ['2', 1, 0],
      ['10', 2, 1],
    ])
    const replay = projectConvertedClarifyAnswers(
      sink.rows('clarify_rounds')[0]!,
      converted,
      sink.rows('clarify_answer_drafts'),
      sink.rows('clarify_answer_attributions'),
    )
    const old = projectClarifyAnswers(
      decodeLegacyClarifyAnswerColumns({
        answersJson: source.values.answers_json as string,
        draftAnswersJson: source.values.draft_answers_json as string,
        answerAttributionsJson: source.values.answer_attributions_json as string,
      }).state,
    )
    expect(replay.answers).toEqual(old.answers)
    expect(replay.draftAnswers).toEqual(old.draftAnswers)
    expect(replay.answerAttributions).toEqual(old.answerAttributions)
    expect(replay.firstAnswer('q')).toEqual(old.firstAnswer('q'))
    expect(replay.answerMap().get('q')).toEqual(old.answerMap().get('q'))
    expect(dispositions.some((d) => d.decision?.code === 'v2-clarify-decisions')).toBe(true)
    expect(units.flatMap((u) => u.archives)).toHaveLength(1)
  }, 180_000)

  test('partial seal stays awaiting and aligns only a NULL container from the intermediary frame', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h, 'task', 'awaiting_human', 'executable')
    await h.write('node_runs', [
      { id: 'wrapper', task_id: 'task', node_id: 'w', status: 'done', seq: 2, started_at: 100 },
    ])
    await h.write('clarify_rounds', [
      roundRow('partial', 'task', {
        status: 'awaiting_human',
        answered_at: null,
        questions_json: JSON.stringify([question(), question('q2')]),
        answers_json: JSON.stringify([answer()]),
        draft_answers_json: '{"q2":{"customText":"draft"}}',
        iteration: 4,
      }),
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [{ ...frame, containerRunId: 'wrapper', iteration: 9, quality: 'legacy-derived' }],
    })
    expect(summary.status).toBe('converted')
    expect(sink.rows('clarify_rounds')[0]).toMatchObject({
      status: 'awaiting_human',
      sealed_question_set_key: null,
      container_run_id: 'wrapper',
      iteration: 4,
    })
    expect(sink.rows('clarify_answers')[0]?.updated_at).toBe(110)
    expect(sink.rows('clarify_answer_drafts')).toHaveLength(1)
  }, 180_000)

  test('all D4 classes govern an awaiting ambiguous round without recomputing status', async () => {
    await h.install()
    const fixtures = []
    for (const [status, execution] of taskClasses) {
      fixtures.push(await seedCollabTask(h, status, status, execution))
      await h.write('clarify_rounds', [
        roundRow(status, status, {
          status: 'awaiting_human',
          questions_json: JSON.stringify([question(), question()]),
          answers_json: JSON.stringify([answer(), answer()]),
        }),
      ])
    }
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: fixtures.map((f) => f.task),
      runFrames: fixtures.map((f) => f.frame),
    })
    expect(
      summary.blocks
        .filter((b) => b.code === 'v2-clarify-duplicate-question')
        .map((b) => b.taskId)
        .sort(),
    ).toEqual(['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted'].sort())
    expect(
      sink
        .rows('clarify_rounds')
        .map((r) => r.task_id)
        .sort(),
    ).toEqual(['canceled', 'done', 'failed'])
    expect(
      dispositions
        .filter((d) => d.kind === 'history-only')
        .map((d) => [d.history?.taskId, d.history?.execution])
        .sort(),
    ).toEqual([
      ['canceled', 'retryable-history'],
      ['done', 'terminal-history'],
      ['failed', 'retryable-history'],
    ])
    expect(summary.historyOnly).toHaveLength(3)
  }, 180_000)

  test('missing and conflicting frames block executable facts and list history restrictions', async () => {
    await h.install()
    const active = await seedCollabTask(h, 'active', 'done', 'executable')
    const history = await seedCollabTask(h, 'history', 'running', 'retryable-history')
    await h.write('clarify_rounds', [roundRow('active', 'active'), roundRow('history', 'history')])
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [active.task, history.task],
      runFrames: [],
    })
    expect(
      summary.blocks.some((b) => b.code === 'v2-clarify-frame-unproven' && b.taskId === 'active'),
    ).toBe(true)
    expect(sink.rows('clarify_rounds').map((r) => r.id)).toEqual(['history'])
    expect(dispositions.find((d) => d.kind === 'history-only')?.history?.missingFields).toContain(
      'container_run_id',
    )
  }, 180_000)

  test('NULL, JSON null, empty and standalone attributions round-trip independently of answers and drafts', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h, 'task', 'awaiting_human', 'executable')
    const maps = [
      null,
      'null',
      '{}',
      '{ "q": { "userId":"editor", "role":"owner", "updatedAt":101 } }',
    ]
    await h.write(
      'clarify_rounds',
      maps.map((raw, index) =>
        roundRow(`attr-${index}`, 'task', {
          status: 'awaiting_human',
          answered_at: null,
          answer_attributions_json: raw,
        }),
      ),
    )
    const { summary, sink } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.status).toBe('converted')
    expect(summary.historyOnly).toEqual([])
    expect(sink.rows('clarify_answers')).toEqual([])
    expect(sink.rows('clarify_answer_drafts')).toEqual([])
    for (const [index, raw] of maps.entries()) {
      const round = sink.rows('clarify_rounds').find((row) => row.id === `attr-${index}`)!
      const attrs = sink
        .rows('clarify_answer_attributions')
        .filter((row) => row.round_id === round.id)
      expect(round.attributions_recorded).toBe(index >= 2)
      expect(projectConvertedClarifyAnswers(round, [], [], attrs).answerAttributions).toEqual(
        decodeLegacyClarifyAnswerColumns({ answerAttributionsJson: raw }).answerAttributions,
      )
    }
    expect(sink.rows('clarify_answer_attributions')[0]).toEqual({
      round_id: 'attr-3',
      question_id: 'q',
      occurrence: 0,
      ordinal: 0,
      value_json: '{ "userId":"editor", "role":"owner", "updatedAt":101 }',
    })
  }, 180_000)

  test('attribution occurrences follow raw text order, retain raw values and replay last keys after freeze', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h)
    const raw =
      '{"10": { "userId":"first" },"2":null,"10": {"userId":"last"},"q":{"userId":"editor"}}'
    await h.write('clarify_rounds', [
      roundRow('attrs', 'task', {
        answers_json: JSON.stringify([answer()]),
        draft_answers_json: null,
        answer_attributions_json: raw,
      }),
    ])
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.status).toBe('converted')
    const attrs = [...sink.rows('clarify_answer_attributions')].sort(
      (a, b) => Number(a.ordinal) - Number(b.ordinal),
    )
    expect(
      attrs.map((row) => [row.question_id, row.occurrence, row.ordinal, row.value_json]),
    ).toEqual([
      ['10', 0, 0, '{ "userId":"first" }'],
      ['2', 0, 1, 'null'],
      ['10', 1, 2, '{"userId":"last"}'],
      ['q', 0, 3, '{"userId":"editor"}'],
    ])
    const replay = projectConvertedClarifyAnswers(
      sink.rows('clarify_rounds')[0]!,
      sink.rows('clarify_answers'),
      [],
      attrs,
    )
    expect(replay.answerAttributions).toEqual(JSON.parse(raw))
    expect(sink.rows('clarify_answers')[0]).not.toHaveProperty('attribution_json')
    expect(JSON.stringify(dispositions)).toContain('v2-clarify-duplicate-attribution')
    expect(JSON.stringify(dispositions)).toContain('v2-clarify-orphan-attribution')
  }, 180_000)

  test('non-array legacy answers preserve verbatim bytes, REST detail and distillation content', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h)
    const values = [
      null,
      '{}',
      ' "legacy" \n',
      '0',
      'null',
      'false',
      '[]',
      JSON.stringify([answer()]),
    ]
    await h.write(
      'clarify_rounds',
      values.map((raw, index) => roundRow(`legacy-${index}`, 'task', { answers_json: raw })),
    )
    const { summary, sink } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.status).toBe('converted')
    for (const [index, raw] of values.entries()) {
      const round = sink.rows('clarify_rounds').find((row) => row.id === `legacy-${index}`)!
      const answers = sink.rows('clarify_answers').filter((row) => row.round_id === round.id)
      const legacy = raw !== null && !Array.isArray(JSON.parse(raw))
      expect(round.legacy_answers_json).toBe(legacy ? raw : null)
      expect(round.answers_recorded).toBe(raw !== null && !legacy)
      const replay = projectConvertedClarifyAnswers(round, answers, [], [])
      const source = decodeLegacyClarifyAnswerColumns({ answersJson: raw })
      expect(replay.answers).toEqual(source.answers)
      expect(replay.detailAnswers).toEqual(source.detailAnswers)
      expect(replay.content).toEqual(source.content)
      expect(clarifyAnswerContentForPrompt(replay.content)).toEqual(
        clarifyAnswerContentForPrompt(source.content),
      )
    }
    expect(
      projectConvertedClarifyAnswers(
        sink.rows('clarify_rounds').find((row) => row.id === 'legacy-0')!,
        [],
        [],
        [],
      ).detailAnswers,
    ).toBeUndefined()
    expect(
      projectConvertedClarifyAnswers(
        sink.rows('clarify_rounds').find((row) => row.id === 'legacy-4')!,
        [],
        [],
        [],
      ).detailAnswers,
    ).toBeNull()
  }, 180_000)

  test('all five clarify JSON takeovers use D4, preserve raw diagnostics and decide every failed column', async () => {
    await h.install()
    const fixtures = []
    const columns = [
      'questions_json',
      'answers_json',
      'draft_answers_json',
      'answer_attributions_json',
      'truncation_warnings_json',
    ] as const
    for (const [status, execution] of taskClasses) {
      fixtures.push(await seedCollabTask(h, status, status, execution))
      await h.write(
        'clarify_rounds',
        columns.map((column) => roundRow(`${status}-${column}`, status, { [column]: '{broken' })),
      )
      await h.write('clarify_rounds', [
        roundRow(`${status}-combined`, status, {
          answers_json: '{bad-answer',
          draft_answers_json: '{bad-draft',
          answer_attributions_json: '{bad-attribution',
        }),
      ])
    }
    const { summary, sink, dispositions, units } = await convertFixtures(h, [conversion], {
      taskFacts: fixtures.map((f) => f.task),
      runFrames: fixtures.map((f) => f.frame),
    })
    expect(
      summary.blocks.some((block) =>
        ['v2-source-codec', 'v2-undecided-source-codec', 'v2-target-codec'].includes(block.code),
      ),
    ).toBe(false)
    for (const [status, execution] of taskClasses) {
      const taskBlocks = summary.blocks.filter((block) => block.taskId === status)
      expect(taskBlocks.some((block) => block.code === 'v2-clarify-json-unproven')).toBe(
        execution === 'executable',
      )
      const rounds = sink.rows('clarify_rounds').filter((row) => row.task_id === status)
      expect(rounds).toHaveLength(execution === 'executable' ? 0 : 6)
      if (execution === 'executable') continue
      for (const column of columns) {
        const round = rounds.find((row) => row.id === `${status}-${column}`)!
        const disposition = dispositions.find(
          (d) =>
            d.kind === 'history-only' &&
            d.targets.some(
              (target) =>
                target.table === 'clarify_rounds' && target.key.includes(String(round.id)),
            ),
        )!
        expect(disposition.codecColumns).toEqual([column])
        expect(disposition.history).toMatchObject({
          taskId: status,
          execution,
          missingFields: expect.arrayContaining([column]),
        })
        if (column === 'questions_json') expect(round.questions_json).toBe('[]')
        if (column === 'truncation_warnings_json') expect(round.truncation_warnings_json).toBeNull()
        if (column === 'answers_json') {
          expect(round.legacy_answers_json).toBe('{broken')
          const replay = projectConvertedClarifyAnswers(round, [], [], [])
          expect(replay.detailAnswers).toBeUndefined()
          expect(replay.content).toEqual({ kind: 'malformed', text: '{broken' })
        }
      }
      const combined = dispositions.find(
        (d) => d.kind === 'history-only' && d.sourceKey.includes(`${status}-combined`),
      )!
      expect([...(combined.codecColumns ?? [])].sort()).toEqual([
        'answer_attributions_json',
        'answers_json',
        'draft_answers_json',
      ])
    }
    expect(summary.historyOnly).toHaveLength(18)
    const archived = units
      .flatMap((unit) => unit.archives)
      .map((archive) => decodeStagedValue<SourceRow>(new TextDecoder().decode(archive.bytes)))
    expect(archived).toHaveLength(48)
    for (const row of archived)
      for (const failure of row.codecTakeovers ?? []) {
        expect(failure.message).not.toBe('')
        expect(failure.raw.value).toMatchObject({ type: 'text' })
        expect(row.raw?.cells[failure.column]).toEqual(failure.raw)
      }
  }, 180_000)

  test('invalid question shapes and unkeyed answers are D4 history evidence, never invented question identities', async () => {
    await h.install()
    const fixtures = []
    for (const [status, execution] of taskClasses) {
      fixtures.push(await seedCollabTask(h, status, status, execution))
      await h.write('clarify_rounds', [
        roundRow(`${status}-questions`, status, { questions_json: '{"legacy":true}' }),
        roundRow(`${status}-answer`, status, { answers_json: '[{"customText":"no question id"}]' }),
      ])
    }
    const { summary, sink, dispositions, units } = await convertFixtures(h, [conversion], {
      taskFacts: fixtures.map((f) => f.task),
      runFrames: fixtures.map((f) => f.frame),
    })
    expect(summary.blocks).toHaveLength(10)
    expect(summary.historyOnly).toHaveLength(6)
    expect(sink.rows('clarify_answers')).toEqual([])
    expect(sink.rows('clarify_rounds')).toHaveLength(3)
    for (const round of sink.rows('clarify_rounds')) {
      expect(round.questions_json).toBe('{"legacy":true}')
      expect(round.sealed_question_set_key).toBeNull()
    }
    for (const status of ['failed', 'canceled', 'done']) {
      const disposition = dispositions.find(
        (d) => d.kind === 'history-only' && d.sourceKey.includes(`${status}-answer`),
      )!
      expect(disposition.targets).toEqual([])
      expect(disposition.archive).not.toBeNull()
      expect(disposition.history?.missingFields).toContain('answers_json.questionId')
    }
    expect(units.flatMap((unit) => unit.archives)).toHaveLength(16)
  }, 180_000)

  test('awaiting orphan answers/drafts and duplicate draft keys are individually decided', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h, 'task', 'awaiting_human', 'executable')
    await h.write('clarify_rounds', [
      roundRow('orphan-answer', 'task', {
        status: 'awaiting_human',
        answers_json: JSON.stringify([answer('missing')]),
      }),
      roundRow('orphan-draft', 'task', {
        status: 'awaiting_human',
        draft_answers_json: '{"missing":{"customText":"draft"}}',
      }),
      roundRow('orphan-attribution', 'task', {
        status: 'awaiting_human',
        answer_attributions_json: '{"missing":{"userId":"editor"}}',
      }),
      roundRow('duplicate-attribution', 'task', {
        status: 'awaiting_human',
        answer_attributions_json: '{"q":null,"q":{"userId":"editor"}}',
      }),
      roundRow('duplicate-draft', 'task', {
        status: 'awaiting_human',
        draft_answers_json: '{"q":{"customText":"first"},"q":{"customText":"last"}}',
      }),
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [frame],
    })
    expect(summary.blocks.map((b) => b.code).sort()).toEqual(
      [
        'v2-clarify-orphan-answer',
        'v2-clarify-orphan-draft',
        'v2-clarify-duplicate-draft',
        'v2-clarify-orphan-attribution',
        'v2-clarify-duplicate-attribution',
      ].sort(),
    )
    expect(sink.rows('clarify_rounds')).toEqual([])
  }, 180_000)

  test('frame conflict keeps the recorded history value, while missing TASK_FACTS blocks classification', async () => {
    await h.install()
    const { task, frame } = await seedCollabTask(h)
    await h.write('clarify_rounds', [
      roundRow('conflict', 'task', { container_run_id: 'recorded-frame' }),
    ])
    const converted = await convertFixtures(h, [conversion], {
      taskFacts: [task],
      runFrames: [{ ...frame, containerRunId: 'different' }],
    })
    expect(converted.sink.rows('clarify_rounds')[0]?.container_run_id).toBe('recorded-frame')
    expect(
      converted.dispositions.find((d) => d.kind === 'history-only')?.history?.missingFields,
    ).toEqual(['container_run_id'])
    const missing = await convertFixtures(h, [conversion], { taskFacts: [], runFrames: [frame] })
    expect(missing.summary.blocks.map((b) => b.code)).toContain('v2-clarify-task-facts-missing')
  }, 180_000)
})
