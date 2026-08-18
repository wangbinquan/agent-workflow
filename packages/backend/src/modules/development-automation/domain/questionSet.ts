// RFC-310 PR-3 T38a —— QuestionSet / AnswerSet 编解码（design §closed 澄清闭环）。
//
// 澄清是 closed decision/effect：问题集与答案集都是不可变 JSON 文档，存进
// evidence bundle（developmentBundleRefs purpose = 'question-set' / 'answer-set'），
// DB/prompt 只持 ref 与 digest。exact-revision 语义：answerRevision 是答案内容
// 的 canonical digest（同答案恒同 revision，重放天然幂等）；correlation 由
// questionSetRef + 原渠道 correlationRef 双键钉住，答案必须逐题对得上问题集
// （未知 questionId 一律拒绝——原渠道的自由文本不允许扩散进决策面）。

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'

export const requirementQuestionSchema = z
  .object({
    questionId: z.string().min(1).max(120),
    text: z.string().min(1).max(4000),
    /** closed 答案形状：v1 只有自由文本与单选（选项也是 closed 列表）。 */
    answerKind: z.enum(['text', 'single-choice']),
    choices: z.array(z.string().min(1).max(200)).max(20).nullable(),
  })
  .strict()

export const questionSetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    missionRef: z.string().min(1),
    /** 谁提出：platform（人工/规则）或 agent（能力动作产出，PR-4 接线）。 */
    origin: z.enum(['platform', 'agent']),
    /** 投递渠道：平台内答复，或写回原需求系统由原渠道作答。 */
    channel: z.enum(['platform', 'requirement-source']),
    questions: z.array(requirementQuestionSchema).min(1).max(50),
  })
  .strict()
  .superRefine((qs, ctx) => {
    const ids = new Set<string>()
    qs.questions.forEach((q, index) => {
      if (ids.has(q.questionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate questionId: ${q.questionId}`,
          path: ['questions', index, 'questionId'],
        })
      }
      ids.add(q.questionId)
      if (q.answerKind === 'single-choice' && (q.choices === null || q.choices.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'single-choice question needs choices',
          path: ['questions', index, 'choices'],
        })
      }
      if (q.answerKind === 'text' && q.choices !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'text question must not carry choices',
          path: ['questions', index, 'choices'],
        })
      }
    })
  })

export type QuestionSetV1 = z.infer<typeof questionSetV1Schema>

export const requirementAnswerSchema = z
  .object({ questionId: z.string().min(1).max(120), answer: z.string().min(1).max(8000) })
  .strict()

export const answerSetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    questionSetRef: z.string().min(1),
    channel: z.enum(['platform', 'requirement-source']),
    /** exact revision：内容 canonical digest（见文件头）。 */
    answerRevision: z.string().min(1).max(200),
    answers: z.array(requirementAnswerSchema).min(1).max(50),
    complete: z.boolean(),
  })
  .strict()

export type AnswerSetV1 = z.infer<typeof answerSetV1Schema>

/** 答案内容的 exact revision：只覆盖答案本体（排序稳定，重放同值）。 */
export function answerRevisionOf(
  answers: readonly { readonly questionId: string; readonly answer: string }[],
): string {
  const sorted = [...answers].sort((a, b) =>
    a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0,
  )
  return canonicalDigest(sorted.map((a) => ({ questionId: a.questionId, answer: a.answer })))
}

export interface AnswerCorrelationViolation {
  readonly code: 'unknown-question' | 'duplicate-answer' | 'choice-outside-list'
  readonly questionId: string
}

/**
 * 答案与问题集对拍：未知题 / 重复答 / 单选越选项一律违规；complete = 每题
 * 恰好一答。原渠道收取与平台提交共用同一判定（closed 语义单点）。
 */
export function correlateAnswers(
  questionSet: QuestionSetV1,
  answers: readonly { readonly questionId: string; readonly answer: string }[],
): { readonly violations: AnswerCorrelationViolation[]; readonly complete: boolean } {
  const byId = new Map(questionSet.questions.map((q) => [q.questionId, q]))
  const violations: AnswerCorrelationViolation[] = []
  const answered = new Set<string>()
  for (const answer of answers) {
    const question = byId.get(answer.questionId)
    if (question === undefined) {
      violations.push({ code: 'unknown-question', questionId: answer.questionId })
      continue
    }
    if (answered.has(answer.questionId)) {
      violations.push({ code: 'duplicate-answer', questionId: answer.questionId })
      continue
    }
    answered.add(answer.questionId)
    if (
      question.answerKind === 'single-choice' &&
      question.choices !== null &&
      !question.choices.includes(answer.answer)
    ) {
      violations.push({ code: 'choice-outside-list', questionId: answer.questionId })
    }
  }
  return {
    violations,
    complete: violations.length === 0 && answered.size === questionSet.questions.length,
  }
}
