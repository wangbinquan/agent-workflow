// RFC-310 PR-3 T38a —— 澄清问答 closed 闭环。
//
// 两条渠道各自全链：
// - requirement-source：stashQuestionSet → reconciler 派 publish（adapter
//   writeback 拿 correlationRef）→ collect 轮询（未齐 = durable wake，不算
//   失败）→ mock 灌答案 → answers-committed + exact answerRevision + answer
//   set 入 evidence 台账 → 规则据 clarificationState 放行动作。
// - platform：publish 把 mission 推到 awaiting-information → reconcile 只
//   wait 不 block → submitMissionAnswers correlate（未知题/漏答被拒）→
//   working + answers-committed。
// 另锁 questionSet domain 编解码：dup id / 单选选项 / correlate / exact
// revision 的排序不敏感性。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import {
  startRequirementProviderMock,
  type StartedRequirementProviderMock,
} from '@agent-workflow/system-mocks/development/requirement-provider'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { submitMissionAnswers } from '../src/modules/development-automation/application/commands/submitMissionAnswers'
import {
  answerRevisionOf,
  correlateAnswers,
  questionSetV1Schema,
} from '../src/modules/development-automation/domain/questionSet'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

let mock: StartedRequirementProviderMock

beforeAll(async () => {
  mock = await startRequirementProviderMock()
  mock.mock.seed({
    externalId: 'REQ-Q',
    revision: 'r1',
    title: 'Ambiguous demand',
    files: [
      {
        fileId: 'f1',
        name: 'body.md',
        role: 'body',
        mediaType: 'text/markdown',
        content: 'vague\n',
      },
    ],
  })
})

afterAll(async () => {
  await mock.close()
})

/** 规则含 clarificationState 谓词：答案未提交前动作不可达。 */
const CLARIFYING_RULES = [
  {
    ruleId: 'impl-after-clarify',
    when: [
      { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
      {
        kind: 'enum-equals',
        fact: 'requirement.clarificationState',
        value: 'answers-committed',
      },
      { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
    ],
    capabilityId: 'change.implement' as const,
  },
]

describe('rfc310 pr3 — requirement-source clarification loop', () => {
  test('publish → poll (durable wake) → answers seeded → committed with exact revision → action unlocked', async () => {
    const fx = await buildPr3Fixture({ rules: CLARIFYING_RULES, external: { mockUrl: mock.url } })
    const missionId = await fx.launchExternal('rfc310-pr3-q-ext-1', 'REQ-Q')
    const deps = fx.deps({
      repositoryFacts: {
        async collect() {
          return { cells: { ...PR3_JAVA_CELLS }, factsRef: 'probe-1' }
        },
      },
      agentLauncher: {
        async launch() {
          return { ok: true, executionRef: 'exec-1' }
        },
      },
    })

    await runMissionReconcile(deps, missionId) // 物化 bundle
    const stashed = await fx.materializer.stashQuestionSet({
      missionId,
      origin: 'agent',
      channel: 'requirement-source',
      questions: [
        { questionId: 'q1', text: 'which module?', answerKind: 'text', choices: null },
        {
          questionId: 'q2',
          text: 'blocking?',
          answerKind: 'single-choice',
          choices: ['yes', 'no'],
        },
      ],
    })
    expect(stashed.ok).toBe(true)
    if (!stashed.ok) return

    // publish：adapter writeback 真跑，mock 侧出现问题集。
    const publishRound = await runMissionReconcile(deps, missionId)
    expect(publishRound.kind === 'decided' && publishRound.selected.kind).toBe(
      'publish-requirement-questions',
    )
    expect(publishRound.kind === 'decided' && publishRound.handled).toBe('collected')
    const questionSets = mock.mock.listQuestionSets()
    expect(questionSets).toHaveLength(1)
    expect(questionSets[0]!.externalId).toBe('REQ-Q')
    expect(questionSets[0]!.questions.map((q) => q.questionId)).toEqual(['q1', 'q2'])
    const correlationId = questionSets[0]!.correlationId

    // collect：答案未齐 = durable wake（不是失败、不是 block）。
    const pollRound = await runMissionReconcile(deps, missionId)
    expect(pollRound.kind === 'decided' && pollRound.selected.kind).toBe(
      'collect-requirement-answers',
    )
    expect(pollRound.kind === 'decided' && pollRound.handled).toBe('wake-armed')
    expect(fx.store.getMission(missionId)!.status).toBe('working')

    // 原渠道作答 → 收取 → answers-committed + exact revision + evidence 台账。
    mock.mock.seedAnswers(
      correlationId,
      [
        { questionId: 'q1', answer: 'billing' },
        { questionId: 'q2', answer: 'yes' },
      ],
      'ans-rev-7',
    )
    const commitRound = await runMissionReconcile(deps, missionId)
    expect(commitRound.kind === 'decided' && commitRound.selected.kind).toBe(
      'collect-requirement-answers',
    )
    expect(commitRound.kind === 'decided' && commitRound.handled).toBe('collected')
    const cells = fx.snapshots.getCells(fx.store.getMission(missionId)!.requirementBundleRef!)!
    expect(cells['requirement.clarificationState']).toMatchObject({
      state: 'known',
      value: 'answers-committed',
    })
    expect(cells['__requirement.answerRevision']).toMatchObject({ value: 'ans-rev-7' })

    // 规则据 clarificationState 放行：repo facts → 动作。
    const factsRound = await runMissionReconcile(deps, missionId)
    expect(factsRound.kind === 'decided' && factsRound.selected.kind).toBe(
      'collect-repository-facts',
    )
    const actionRound = await runMissionReconcile(deps, missionId)
    expect(actionRound.kind === 'decided' && actionRound.handled).toBe('action-launched')
  })
})

describe('rfc310 pr3 — platform clarification channel', () => {
  test('publish moves to awaiting-information; submit correlates, freezes and resumes working', async () => {
    const fx = await buildPr3Fixture({ rules: CLARIFYING_RULES })
    const missionId = await fx.launchDirect('rfc310-pr3-q-plat-1')
    await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    const deps = fx.deps()

    await runMissionReconcile(deps, missionId) // 物化
    const stashed = await fx.materializer.stashQuestionSet({
      missionId,
      origin: 'platform',
      channel: 'platform',
      questions: [
        { questionId: 'q1', text: 'scope?', answerKind: 'text', choices: null },
        { questionId: 'q2', text: 'deadline?', answerKind: 'text', choices: null },
      ],
    })
    expect(stashed.ok).toBe(true)
    if (!stashed.ok) return

    const publishRound = await runMissionReconcile(deps, missionId)
    expect(publishRound.kind === 'decided' && publishRound.selected.kind).toBe(
      'publish-requirement-questions',
    )
    expect(fx.store.getMission(missionId)!.status).toBe('awaiting-information')

    // 等待人答：wait（wake-armed），绝不 block。
    const waitRound = await runMissionReconcile(deps, missionId)
    expect(waitRound.kind === 'decided' && waitRound.selected.kind).toBe('wait')
    expect(waitRound.kind === 'decided' && waitRound.handled).toBe('wake-armed')

    const commandDeps = {
      store: fx.store,
      snapshots: fx.snapshots,
      requirement: fx.materializer,
      now: () => Date.now(),
    }
    // 未知题被拒。
    await expect(
      submitMissionAnswers(commandDeps, {
        missionId,
        questionSetRef: stashed.questionSetRef,
        answers: [{ questionId: 'nope', answer: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'answer-correlation-violation' })
    // 漏答被拒（提交即冻结 ⇒ 必须齐）。
    await expect(
      submitMissionAnswers(commandDeps, {
        missionId,
        questionSetRef: stashed.questionSetRef,
        answers: [{ questionId: 'q1', answer: 'only one' }],
      }),
    ).rejects.toMatchObject({ code: 'answers-incomplete' })
    // 拿非 pending 的 ref 灌答案被拒。
    await expect(
      submitMissionAnswers(commandDeps, {
        missionId,
        questionSetRef: 'not-the-pending-one',
        answers: [
          { questionId: 'q1', answer: 'a' },
          { questionId: 'q2', answer: 'b' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'question-set-not-pending' })

    const result = await submitMissionAnswers(commandDeps, {
      missionId,
      questionSetRef: stashed.questionSetRef,
      answers: [
        { questionId: 'q1', answer: 'whole billing module' },
        { questionId: 'q2', answer: 'friday' },
      ],
    })
    expect(result.status).toBe('working')
    expect(result.answerRevision).toBe(
      answerRevisionOf([
        { questionId: 'q1', answer: 'whole billing module' },
        { questionId: 'q2', answer: 'friday' },
      ]),
    )
    const cells = fx.snapshots.getCells(fx.store.getMission(missionId)!.requirementBundleRef!)!
    expect(cells['requirement.clarificationState']).toMatchObject({
      value: 'answers-committed',
    })
  })
})

describe('rfc310 pr3 — questionSet domain codec', () => {
  const base = {
    schemaVersion: 1,
    missionRef: 'm1',
    origin: 'platform',
    channel: 'platform',
  }

  test('duplicate question ids and malformed choice shapes are rejected', () => {
    expect(
      questionSetV1Schema.safeParse({
        ...base,
        questions: [
          { questionId: 'q1', text: 'a', answerKind: 'text', choices: null },
          { questionId: 'q1', text: 'b', answerKind: 'text', choices: null },
        ],
      }).success,
    ).toBe(false)
    expect(
      questionSetV1Schema.safeParse({
        ...base,
        questions: [{ questionId: 'q1', text: 'a', answerKind: 'single-choice', choices: null }],
      }).success,
    ).toBe(false)
    expect(
      questionSetV1Schema.safeParse({
        ...base,
        questions: [{ questionId: 'q1', text: 'a', answerKind: 'text', choices: ['x'] }],
      }).success,
    ).toBe(false)
  })

  test('correlateAnswers: unknown/duplicate/choice-outside-list violations; complete only when every question answered', () => {
    const qs = questionSetV1Schema.parse({
      ...base,
      questions: [
        { questionId: 'q1', text: 'a', answerKind: 'text', choices: null },
        { questionId: 'q2', text: 'b', answerKind: 'single-choice', choices: ['yes', 'no'] },
      ],
    })
    expect(correlateAnswers(qs, [{ questionId: 'zzz', answer: 'x' }]).violations[0]).toMatchObject({
      code: 'unknown-question',
    })
    expect(
      correlateAnswers(qs, [
        { questionId: 'q1', answer: 'x' },
        { questionId: 'q1', answer: 'y' },
      ]).violations[0],
    ).toMatchObject({ code: 'duplicate-answer' })
    expect(
      correlateAnswers(qs, [{ questionId: 'q2', answer: 'maybe' }]).violations[0],
    ).toMatchObject({ code: 'choice-outside-list' })
    expect(correlateAnswers(qs, [{ questionId: 'q1', answer: 'x' }]).complete).toBe(false)
    expect(
      correlateAnswers(qs, [
        { questionId: 'q1', answer: 'x' },
        { questionId: 'q2', answer: 'yes' },
      ]).complete,
    ).toBe(true)
  })

  test('answerRevisionOf is order-insensitive (exact revision semantics)', () => {
    const a = answerRevisionOf([
      { questionId: 'q1', answer: 'x' },
      { questionId: 'q2', answer: 'y' },
    ])
    const b = answerRevisionOf([
      { questionId: 'q2', answer: 'y' },
      { questionId: 'q1', answer: 'x' },
    ])
    const c = answerRevisionOf([
      { questionId: 'q1', answer: 'x' },
      { questionId: 'q2', answer: 'CHANGED' },
    ])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
