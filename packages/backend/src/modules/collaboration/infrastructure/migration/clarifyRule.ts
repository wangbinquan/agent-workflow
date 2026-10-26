import { clarifyQuestionSetKey, type ClarifyQuestion } from '@agent-workflow/shared'
import { decodeLegacyClarifyAnswerColumns } from '../clarifyAnswerCodec'
import {
  RUN_FRAMES,
  TASK_FACTS,
  type RunFrame,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { scanJsonObjectEntries } from '@/platform/persistence/migration/conversion/orderedJson'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  JsonValue,
  SourceRow,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { recordCollaborationDecision } from './evidence'

type Decision = {
  code: string
  detail: JsonValue
}
function object(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The projection used to prove the migrated children preserve today's first/last semantics. */
export function projectConvertedClarifyAnswers(
  round: TargetRow,
  answers: readonly TargetRow[],
  drafts: readonly TargetRow[],
  attributions: readonly TargetRow[],
) {
  const ordered = (rows: readonly TargetRow[]) =>
    [...rows].sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
  const mapJson = (rows: readonly TargetRow[]) =>
    `{${ordered(rows)
      .map((row) => `${JSON.stringify(row.question_id)}:${String(row.value_json)}`)
      .join(',')}}`
  return decodeLegacyClarifyAnswerColumns({
    answersJson:
      typeof round.legacy_answers_json === 'string'
        ? round.legacy_answers_json
        : round.answers_recorded
          ? `[${ordered(answers)
              .map((row) => String(row.value_json))
              .join(',')}]`
          : null,
    draftAnswersJson: round.drafts_recorded ? mapJson(drafts) : null,
    answerAttributionsJson: round.attributions_recorded ? mapJson(attributions) : null,
  })
}

export function decomposeClarifyRound(
  row: SourceRow,
  frame: RunFrame | undefined,
  execution: TaskFacts['execution'],
) {
  const decisions: Decision[] = []
  const blocks: ConversionBlock[] = []
  const missingFields: string[] = []
  const answers: TargetRow[] = []
  const drafts: TargetRow[] = []
  const attributions: TargetRow[] = []
  let representable = true
  const v = row.values
  const round: Record<string, TargetRow[string]> = Object.fromEntries(
    Object.entries(v).filter(
      ([key]) => !['answers_json', 'draft_answers_json', 'answer_attributions_json'].includes(key),
    ),
  )
  Object.assign(round, {
    questions_revision: 1,
    sealed_question_set_key: null,
    answers_recorded: false,
    drafts_recorded: false,
    attributions_recorded: false,
    legacy_answers_json: null,
  })
  const uncertain = (code: string, fields: string[], detail: JsonValue) => {
    decisions.push({ code, detail })
    missingFields.push(...fields)
    if (execution === 'executable') blocks.push(rowBlock(code, row, detail, fields))
  }
  for (const failure of row.codecTakeovers ?? []) {
    uncertain('v2-clarify-json-unproven', [failure.column], {
      column: failure.column,
      diagnostic: failure.message,
      rule: 'preserve raw evidence and legacy display; restrict historical execution',
    })
    if (typeof v[failure.column] !== 'string') representable = false
    // These two columns survive in the round; malformed text has the same empty/absent REST view.
    if (failure.column === 'questions_json') round.questions_json = '[]'
    if (failure.column === 'truncation_warnings_json') round.truncation_warnings_json = null
  }
  // The deleted frameBackfillStore aligned only a NULL container, from the intermediary run.
  if (
    !frame ||
    frame.runId !== v.intermediary_node_run_id ||
    frame.taskId !== v.task_id ||
    frame.quality === 'unresolved'
  ) {
    uncertain('v2-clarify-frame-unproven', ['intermediary_node_run_id', 'container_run_id'], {
      frame: frame ? { ...frame } : null,
    })
  } else if (v.container_run_id === null) {
    round.container_run_id = frame.containerRunId
    if (frame.containerRunId !== null)
      decisions.push({
        code: 'v2-clarify-frame-aligned',
        detail: { runId: frame.runId, containerRunId: frame.containerRunId },
      })
  } else if (v.container_run_id !== frame.containerRunId) {
    uncertain('v2-clarify-frame-conflict', ['container_run_id'], {
      recorded: v.container_run_id as string,
      derived: frame.containerRunId,
    })
  }
  let questions: unknown
  try {
    questions = JSON.parse(String(v.questions_json))
  } catch {
    questions = null
  }
  const questionsKnown =
    Array.isArray(questions) &&
    questions.every((q: unknown) => object(q) && typeof q.id === 'string')
  if (!questionsKnown)
    uncertain('v2-clarify-questions-shape', ['questions_json'], { column: 'questions_json' })
  const ids = new Set<string>()
  const ambiguity = (code: string, field: string, detail: JsonValue) => {
    if (v.status === 'awaiting_human') uncertain(code, [field], detail)
    else decisions.push({ code, detail })
  }
  for (const [ordinal, q] of (questionsKnown ? (questions as { id: string }[]) : []).entries()) {
    if (ids.has(q.id))
      ambiguity('v2-clarify-duplicate-question', 'questions_json', { questionId: q.id, ordinal })
    ids.add(q.id)
  }
  if (questionsKnown && v.status === 'answered')
    round.sealed_question_set_key = clarifyQuestionSetKey(questions as ClarifyQuestion[])
  const projection = decodeLegacyClarifyAnswerColumns({
    answersJson: typeof v.answers_json === 'string' ? v.answers_json : null,
    draftAnswersJson: typeof v.draft_answers_json === 'string' ? v.draft_answers_json : null,
    answerAttributionsJson:
      typeof v.answer_attributions_json === 'string' ? v.answer_attributions_json : null,
  })
  for (const [column, decoded] of [
    ['answers_json', projection.answers],
    ['draft_answers_json', projection.draftAnswers],
    ['answer_attributions_json', projection.answerAttributions],
  ] as const) {
    if (typeof v[column] === 'string' && decoded === null)
      decisions.push({
        code: 'v2-clarify-legacy-shape',
        detail: { column, evidence: 'source-journal', projection: 'legacy-decoder' },
      })
  }
  round.answers_recorded = projection.answers !== null
  round.drafts_recorded = projection.draftAnswers !== null
  const updatedAt = v.answered_at ?? v.created_at
  round.attributions_recorded = projection.answerAttributions !== null
  if (projection.answers === null && typeof v.answers_json === 'string')
    round.legacy_answers_json = v.answers_json
  const occurrences = new Map<string, number>()
  for (const [ordinal, answer] of (projection.answers ?? []).entries()) {
    if (!object(answer) || typeof answer.questionId !== 'string') {
      uncertain('v2-clarify-answer-key', ['answers_json.questionId'], { ordinal })
      representable = false
      continue
    }
    const id = answer.questionId
    const occurrence = occurrences.get(id) ?? 0
    occurrences.set(id, occurrence + 1)
    if (occurrence)
      ambiguity('v2-clarify-duplicate-answer', 'answers_json', {
        questionId: id,
        ordinal,
        occurrence,
      })
    if (questionsKnown && !ids.has(id))
      ambiguity('v2-clarify-orphan-answer', 'answers_json', { questionId: id, ordinal })
    answers.push({
      round_id: v.id!,
      question_id: id,
      occurrence,
      ordinal,
      value_json: JSON.stringify(answer),
      revision: 1,
      questions_revision: 1,
      updated_at: updatedAt!,
    })
  }
  occurrences.clear()
  if (projection.draftAnswers !== null)
    for (const entry of scanJsonObjectEntries(String(v.draft_answers_json))) {
      const occurrence = occurrences.get(entry.key) ?? 0
      occurrences.set(entry.key, occurrence + 1)
      if (occurrence)
        ambiguity('v2-clarify-duplicate-draft', 'draft_answers_json', {
          questionId: entry.key,
          ordinal: entry.ordinal,
          occurrence,
        })
      if (questionsKnown && !ids.has(entry.key))
        ambiguity('v2-clarify-orphan-draft', 'draft_answers_json', {
          questionId: entry.key,
          ordinal: entry.ordinal,
        })
      const attr = projection.answerAttributions?.[entry.key]
      drafts.push({
        round_id: v.id!,
        question_id: entry.key,
        occurrence,
        ordinal: entry.ordinal,
        value_json: entry.rawValue,
        revision: 1,
        questions_revision: 1,
        updated_at:
          typeof attr?.updatedAt === 'number' && Number.isSafeInteger(attr.updatedAt)
            ? attr.updatedAt
            : v.created_at!,
      })
    }
  occurrences.clear()
  if (projection.answerAttributions !== null)
    for (const entry of scanJsonObjectEntries(String(v.answer_attributions_json))) {
      const occurrence = occurrences.get(entry.key) ?? 0
      occurrences.set(entry.key, occurrence + 1)
      if (occurrence)
        ambiguity('v2-clarify-duplicate-attribution', 'answer_attributions_json', {
          questionId: entry.key,
          ordinal: entry.ordinal,
          occurrence,
        })
      if (questionsKnown && !ids.has(entry.key))
        ambiguity('v2-clarify-orphan-attribution', 'answer_attributions_json', {
          questionId: entry.key,
          ordinal: entry.ordinal,
        })
      attributions.push({
        round_id: v.id!,
        question_id: entry.key,
        occurrence,
        ordinal: entry.ordinal,
        value_json: entry.rawValue,
      })
    }
  if (representable) {
    const replay = projectConvertedClarifyAnswers(round, answers, drafts, attributions)
    for (const key of [
      'answers',
      'draftAnswers',
      'answerAttributions',
      'detailAnswers',
      'content',
    ] as const) {
      const sourceValue = projection[key]
      const targetValue = replay[key]
      if (
        (targetValue === undefined) !== (sourceValue === undefined) ||
        canonicalSchemaJson(targetValue ?? null) !== canonicalSchemaJson(sourceValue ?? null)
      ) {
        uncertain('v2-clarify-projection-unrepresentable', [key], {
          projection: key,
          reason: 'target cannot preserve the source projection',
        })
        representable = false
      }
    }
  }
  return { round, answers, drafts, attributions, decisions, blocks, missingFields, representable }
}

export const clarifyRule: ConversionRule = {
  ref: { id: 'collaboration/clarify-rounds', version: 2 },
  owner: 'collaboration',
  claims: ['clarify_rounds'],
  codecTakeovers: [
    {
      table: 'clarify_rounds',
      columns: [
        'questions_json',
        'answers_json',
        'draft_answers_json',
        'answer_attributions_json',
        'truncation_warnings_json',
      ],
    },
  ],
  produces: [
    'clarify_rounds',
    'clarify_answers',
    'clarify_answer_drafts',
    'clarify_answer_attributions',
  ].map((table) => ({
    table,
  })),
  lookups: [TASK_FACTS, RUN_FRAMES],
  unit: { kind: 'source-chunk', table: 'clarify_rounds' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('clarify_rounds') ?? []) {
      const fact = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
      if (!fact) {
        ctx.out.block(rowBlock('v2-clarify-task-facts-missing', row, null, ['TASK_FACTS']))
        continue
      }
      const result = decomposeClarifyRound(
        row,
        ctx.lookup(RUN_FRAMES).get(String(row.values.intermediary_node_run_id)),
        fact.execution,
      )
      if (result.blocks.length) {
        recordCollaborationDecision(
          row,
          ctx,
          {
            code: 'v2-clarify-unconverted',
            detail: { decisions: result.decisions, blocks: result.blocks.map((b) => b.code) },
          },
          [],
        )
        for (const block of result.blocks) ctx.out.block(block)
        continue
      }
      const targets = result.representable
        ? [
            { table: 'clarify_rounds', values: result.round },
            ...result.answers.map((values) => ({ table: 'clarify_answers', values })),
            ...result.drafts.map((values) => ({ table: 'clarify_answer_drafts', values })),
            ...result.attributions.map((values) => ({
              table: 'clarify_answer_attributions',
              values,
            })),
          ]
        : []
      for (const target of targets) ctx.out.row(target.table, target.values, row)
      if (result.decisions.length)
        recordCollaborationDecision(
          row,
          ctx,
          { code: 'v2-clarify-decisions', detail: result.decisions },
          targets.map((target) => ({
            table: target.table,
            key: ctx.target.key(target.table, target.values),
          })),
          result.missingFields.length
            ? { execution: fact.execution, missingFields: [...new Set(result.missingFields)] }
            : undefined,
        )
    }
  },
}
