// RFC-395 II-a A4: frozen verbatim HEAD reader fragments; never regenerate from candidate code.
// Each source string is byte-copied by git show; path, line and SHA-256 record its provenance.
export const headClarifyReaders = {
  revision: 'fb99b3a0dfffd749b681cc12f867c5085c4eb878',
  queue: {
    path: 'packages/backend/src/modules/collaboration/infrastructure/clarify/queue.ts',
    line: 206,
    sha256: '2511c207bd786fd1db7d745ef85e244d13d95488cb8eb036f7be4b3db2e40c13',
    source:
      "    if (\n      round === undefined ||\n      round.status === 'canceled' ||\n      round.status === 'abandoned' ||\n      round.answersJson === null\n    )\n      continue\n    let questions: ClarifyQuestion[]\n    let answers: ClarifyAnswer[]\n    try {\n      questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]\n      answers = JSON.parse(round.answersJson) as ClarifyAnswer[]\n    } catch (err) {\n      log.warn('clarify queue round JSON parse failed; skipping round', {\n        roundId: round.id,\n        error: err instanceof Error ? err.message : String(err),\n      })\n      continue\n    }\n    roundByOrigin.set(originId, {\n      questions: new Map(questions.map((q) => [q.id, q])),\n      answers: new Map(answers.map((a) => [a.questionId, a])),\n      askingShardKey: round.askingShardKey,\n    })",
  },
  followup: {
    path: 'packages/backend/src/modules/collaboration/infrastructure/clarifyFollowupStore.ts',
    line: 85,
    sha256: 'b3f84dac2927b06b8b6bca2340720c660a3463288b4bfd1083d3e29f0be206dc',
    source:
      "effectiveClarifyAnswers(\n        JSON.parse(round.draftAnswersJson ?? '{}') as Record<string, ClarifyDraftValue>,\n        JSON.parse(round.answersJson ?? '[]'),\n      )",
  },
  strictAnswers: {
    path: 'packages/backend/src/modules/collaboration/infrastructure/clarifyFollowupStore.ts',
    line: 87,
    sha256: '9093a960b39c081d09563dfd1553311345249647076444b01f18e8d510e2e938',
    source: "JSON.parse(round.answersJson ?? '[]')",
  },
  effective: {
    path: 'packages/shared/src/clarifyMindmap.ts',
    line: 82,
    sha256: '7969a441c5ec0e907a77563e3d5eaa726ac85cc2907cec5815a1fb458ef6769b',
    source:
      'export function effectiveClarifyAnswers<T extends ClarifyDraftValue>(\n  drafts: Readonly<Record<string, T>>,\n  submitted: readonly (T & { questionId: string })[] | null | undefined,\n): Record<string, T> {\n  const effective = { ...drafts }\n  for (const answer of submitted ?? []) effective[answer.questionId] = answer\n  return effective\n}',
  },
  committed: {
    path: 'packages/backend/src/modules/collaboration/infrastructure/committedHumanInputQueries.ts',
    line: 34,
    sha256: 'b83b83e560e50bf229fe364a26b2431301b909cb0050a8468a0f3f0ec2e9181d',
    source:
      "row.status === 'answered' && row.answersJson !== null\n            ? z.array(ClarifyAnswerSchema).parse(JSON.parse(row.answersJson))\n            : []",
  },
} as const
