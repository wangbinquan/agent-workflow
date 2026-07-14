// RFC-148 T3 — promptMode / clarifyChannel 判别联合契约。
//
// 为什么这条测试存在：八个散装字段（envelopeFollowup 四件套 + clarify 四
// 布尔）收敛为两个判别联合后，本文件锁三层契约：
//   1. 非法状态类型不可表示（followup 无 session / stopped 无接线）——
//      编译期 @ts-expect-error 断言；
//   2. 渲染投影格：directive × 渲染面（mandatory=ask-back preamble、
//      suppressed/delegated/none=输出协议、stopped+notice=STOP trailer）——
//      特别是设计门 high 要求的 suppressed-cross 回归（review 重跑抑制下
//      prompt 不得带 mandatory preamble）。RFC-183 起投影统一走
//      clarifyDispositionFor 分类器（渲染与 runner 同源），并新增 'delegated'
//      （host 轮）与 'suppressed' 逐字节同支的等式锁；
//   3. runner 源码形态锁：解析 cap 只随接线族（kind==='cross'）不随
//      directive——RFC-183 后 suppressed cross 在解析前即被拒，cap 锚对
//      仍会进入解析的邀请态（mandatory/optional cross）成立。

import type { ClarifyChannel, ClarifyChannelDirective, PromptMode } from '@agent-workflow/shared'
import { clarifyDispositionFor, renderUserPrompt } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const BASE = {
  promptTemplate: 'Work on {{spec}}.',
  inputs: { spec: 'S' },
  meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
  agentOutputs: ['out'],
}

describe('RFC-148 — 非法状态类型不可表示（编译期断言）', () => {
  test('followup 臂必须携带 resumeSessionId；stopped 必须有接线族', () => {
    // @ts-expect-error — followup without resumeSessionId is unrepresentable
    const bad1: PromptMode = { kind: 'followup', reason: 'envelope-missing' }
    // @ts-expect-error — a directive requires a wired kind ('none' has no directive)
    const bad2: ClarifyChannel = { kind: 'none', directive: 'stopped', injectStopNotice: false }
    const good1: PromptMode = {
      kind: 'followup',
      resumeSessionId: 'ses_1',
      reason: 'envelope-missing',
    }
    const good2: ClarifyChannel = {
      kind: 'cross',
      directive: 'suppressed',
      injectStopNotice: false,
    }
    expect([bad1, bad2, good1, good2].length).toBe(4)
  })
})

describe('RFC-148 — clarifyChannel 渲染投影格', () => {
  const render = (clarifyChannel?: ClarifyChannel) =>
    renderUserPrompt({ ...BASE, ...(clarifyChannel !== undefined ? { clarifyChannel } : {}) })

  test('mandatory：注入 MANDATORY ASK-BACK preamble、无输出协议', () => {
    const out = render({ kind: 'self', directive: 'mandatory', injectStopNotice: false })
    expect(out).toContain('MANDATORY ASK-BACK')
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })

  test('suppressed-cross（设计门回归）：review 重跑抑制下 prompt 是纯输出协议——拒绝语义在 runner（RFC-183）', () => {
    const out = render({ kind: 'cross', directive: 'suppressed', injectStopNotice: false })
    expect(out).not.toContain('MANDATORY ASK-BACK')
    expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(out).not.toContain('STOP CLARIFYING')
  })

  test('stopped + injectStopNotice：注入 STOP trailer + 输出协议', () => {
    const out = render({ kind: 'self', directive: 'stopped', injectStopNotice: true })
    expect(out).toContain('STOP CLARIFYING')
    expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(out).not.toContain('MANDATORY ASK-BACK')
  })

  test('stopped 不带 notice / suppressed / delegated / none / 缺省：五者字节相同（纯输出协议，RFC-183 AC6）', () => {
    const stopped = render({ kind: 'self', directive: 'stopped', injectStopNotice: false })
    const suppressed = render({ kind: 'self', directive: 'suppressed', injectStopNotice: false })
    const delegated = render({ kind: 'self', directive: 'delegated', injectStopNotice: false })
    const none = render({ kind: 'none' })
    const absent = render(undefined)
    expect(stopped).toBe(none)
    expect(suppressed).toBe(none)
    expect(delegated).toBe(none)
    expect(none).toBe(absent)
  })

  test('RFC-183：渲染投影按分类器全枚举（新 directive 不入表即编译红）', () => {
    // satisfies 完备性锚：ClarifyChannelDirective 每个成员必须声明期望投影。
    const RENDER_CLASS = {
      mandatory: 'ask-back',
      optional: 'dual',
      suppressed: 'output-only',
      stopped: 'output-only',
      delegated: 'output-only',
    } satisfies Record<ClarifyChannelDirective, 'ask-back' | 'dual' | 'output-only'>
    const baseline = render({ kind: 'none' })
    for (const [directive, cls] of Object.entries(RENDER_CLASS)) {
      const out = render({
        kind: 'self',
        directive: directive as ClarifyChannelDirective,
        injectStopNotice: false,
      })
      if (cls === 'ask-back') {
        expect(out).toContain('MANDATORY ASK-BACK')
        expect(clarifyDispositionFor(directive as ClarifyChannelDirective)).toBe('invite-mandatory')
      } else if (cls === 'dual') {
        expect(out).toContain('OPTIONAL clarify channel')
        expect(out).toContain('<workflow-clarify>')
        expect(clarifyDispositionFor(directive as ClarifyChannelDirective)).toBe('invite-optional')
      } else {
        expect(out).toBe(baseline)
        expect(['reject', 'external']).toContain(
          clarifyDispositionFor(directive as ClarifyChannelDirective),
        )
      }
    }
  })
})

describe('RFC-148 — 存量模板兼容（实现门 high 采纳）', () => {
  test('legacy 死 token 渲染空串（default 分支——与历史字节相同）', () => {
    const out = renderUserPrompt({
      ...BASE,
      promptTemplate: 'A[{{__clarify_questions__}}]B[{{__external_feedback__}}]C',
    })
    expect(out).toContain('A[]B[]C')
  })

  test('退役 token 与同名 input 撞名仍渲染空串（复审 high：不得落 input 查找）', () => {
    const out = renderUserPrompt({
      ...BASE,
      promptTemplate: 'X[{{__clarify_answers__}}]Y',
      inputs: { __clarify_answers__: 'UPSTREAM-CONTENT-MUST-NOT-LEAK' },
    })
    expect(out).toContain('X[]Y')
    expect(out).not.toContain('UPSTREAM-CONTENT-MUST-NOT-LEAK')
  })

  test('legacy 死 token 只降级为 deprecation warning，不阻断启动', async () => {
    const { validateWorkflowDef } = await import('../src/services/workflow.validator')
    const def = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'a',
          kind: 'agent-single',
          agentName: 'w',
          promptTemplate: 'do {{__clarify_answers__}} and {{__external_feedback_sources__}}',
        },
      ],
      edges: [],
    }
    const agents = [
      {
        id: 'w',
        name: 'w',
        description: '',
        outputs: ['out'],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: '',
        schemaVersion: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const res = validateWorkflowDef(def as never, { agents, skills: [] } as never)
    const deprecated = res.issues.filter((i) => i.code === 'prompt-template-deprecated-token')
    expect(deprecated.length).toBe(2)
    expect(deprecated.every((i) => i.severity === 'warning')).toBe(true)
    expect(res.issues.filter((i) => i.code === 'prompt-template-unresolved')).toEqual([])
    expect(res.ok).toBe(true)
  })
})

describe('RFC-148 — runner 源码形态锁（cap 随接线族、门随 directive）', () => {
  const runnerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
    'utf8',
  )

  test('解析 cap 判定锚 kind===cross（不看 directive——RFC-183 后进入解析的是邀请态 cross）', () => {
    expect(runnerSrc).toMatch(
      /channel\.kind === 'cross' \? \{ maxQuestions: Number\.POSITIVE_INFINITY \}/,
    )
  })

  test('RFC-183：门的派生统一走 clarifyDispositionFor（注入⟺接受同源）', () => {
    expect(runnerSrc).toContain(
      'const clarifyDisposition = clarifyWired ? clarifyDispositionFor(channel.directive) : undefined',
    )
    expect(runnerSrc).toContain(
      "const clarifyMandatory = clarifyDisposition === 'invite-mandatory'",
    )
    expect(runnerSrc).toContain("const clarifyOptional = clarifyDisposition === 'invite-optional'")
    expect(runnerSrc).toContain("const clarifyRejectDirective = clarifyDisposition === 'reject'")
  })

  test('followup 判别单点派生（散装 !== true 守卫不得回潮）', () => {
    expect(runnerSrc).toContain("opts.promptMode?.kind === 'followup'")
    expect(runnerSrc).not.toMatch(/envelopeFollowup !== true/)
    expect(runnerSrc).not.toMatch(/\?\? 'envelope-missing'/)
  })
})
