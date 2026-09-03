// RFC-353 T4 —— 融合内建资源的文本 / 图形契约锁。
//
// 为什么这条测试存在：T4 把 fusion 的纯判据与纯文本从 `services/fusion.ts` 平移进
// `modules/knowledge-evolution/domain/`。平移本该零行为改动，但**手抄整段文本极易缺斤少两**
// ——初稿就漏掉了 `MERGER_BODY` 里整段「## After the merger stops clarifying — do the merge」
// （1247 字符抄成 822），是逐字节对拍才逮出来的。漏掉那段的后果不是编译错误，而是
// 内建 merger agent 从此不知道要改哪些文件、要把结果清单写到哪里——线上表现为
// 「融合任务跑完但技能没变」，且没有任何报错。
//
// 所以这里锁的不是「文本等于某个哈希」（红了看不出缺了什么），而是**内建 agent 行为契约的
// 每一条落点**：必答澄清、四个步骤、清单路径与 JSON 形状、脚手架目录不写进技能。
// 任何一条被删掉都会红，且红的信息直接告诉你缺哪条。
//
// 工作流图同理：节点 id / 端口名 / clarify 回边是内建 workflow 的事实源，
// 改了等于换了一个工作流，存量融合任务的重放会对不上。

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { PLATFORM_FUSION_DIR, PLATFORM_FUSION_MANIFEST } from '@agent-workflow/shared'

import {
  MERGER_BODY,
  MERGER_PROMPT_TEMPLATE,
  serializeMemoriesForPrompt,
} from '../src/modules/knowledge-evolution/domain/fusionPrompt'
import { canonicalFusionWorkflowDefinition } from '../src/modules/knowledge-evolution/domain/fusionWorkflowSeed'
import { isValidFusionTransition } from '../src/modules/knowledge-evolution/domain/fusionStateMachine'

/** 16 位就够当绊线；全长哈希在失败信息里只是噪音。 */
const digest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

// ---------------------------------------------------------------------------
// 字节级绊线
//
// 下面的 landmark 断言只能逮**已知**段落被删；逮不住未知的截断、少抄一句、改一个词。
// 这三条 digest 是兜底：任何一个字节的变化都当场红。
//
// **红了怎么办**：先分清是「手滑」还是「有意改内建 agent 的契约」。
//   - 手滑（平移 / 合并 / 编辑器自动换行）：把文本改回去，别改这里的数字；
//   - 有意改：那是产品行为变更——把新数字与**为什么改**写进同一笔提交，
//     让下一个人能从这行 diff 追到那次决定。
// 绝不允许「红了就更新数字」当作例行操作。
// ---------------------------------------------------------------------------
describe('RFC-353 T4 — 内建文本的字节级绊线', () => {
  test('MERGER_BODY 逐字节未变（初稿正是在这里漏抄了 425 个字符）', () => {
    expect({ length: MERGER_BODY.length, digest: digest(MERGER_BODY) }).toEqual({
      length: 2260,
      digest: '118c2dd39ed7d7e3',
    })
  })

  test('MERGER_PROMPT_TEMPLATE 逐字节未变', () => {
    expect({
      length: MERGER_PROMPT_TEMPLATE.length,
      digest: digest(MERGER_PROMPT_TEMPLATE),
    }).toEqual({ length: 268, digest: '873e4524b0fa4eef' })
  })

  test('内建工作流图逐字节未变（多一个字段也红）', () => {
    const def = canonicalFusionWorkflowDefinition({
      workflowId: 'wf',
      workflowName: 'n',
      mergerAgentId: 'a',
      mergerAgentName: 'm',
    })
    expect(digest(JSON.stringify(def))).toBe('6de90c3c24f5b59a')
  })
})

describe('RFC-353 T4 — merger agent 正文的行为契约', () => {
  test('必答澄清那一条还在', () => {
    expect(MERGER_BODY).toContain('## Mandatory ask-back (you are in clarify mode)')
    expect(MERGER_BODY).toContain('at least one clarifying question BEFORE editing anything')
    expect(MERGER_BODY).toContain('Do NOT edit files or emit output while clarifying')
  })

  test('澄清结束之后的四个步骤一个都不能少（初稿正是整段漏掉这里）', () => {
    expect(MERGER_BODY).toContain('## After the merger stops clarifying — do the merge')
    for (const step of [
      '1. Read SKILL.md',
      "2. Integrate the memories' knowledge into the skill",
      '3. Write a manifest to',
      '4. Emit a short summary in the workflow-output envelope',
    ]) {
      expect(MERGER_BODY).toContain(step)
    }
  })

  test('结果清单的路径与 JSON 形状是平台读回来的契约', () => {
    expect(MERGER_BODY).toContain(PLATFORM_FUSION_MANIFEST)
    expect(MERGER_BODY).toContain('"incorporatedMemoryIds"')
    expect(MERGER_BODY).toContain('"skipped"')
    expect(MERGER_BODY).toContain('"changelog"')
    // 「每条被选中的记忆必须落在 incorporated / skipped 之一」——不许静默丢弃。
    expect(MERGER_BODY).toContain('never silently drop')
  })

  test('脚手架目录永远不写进技能', () => {
    expect(MERGER_BODY).toContain(
      `The \`${PLATFORM_FUSION_DIR}/\` directory is framework scaffolding and is never written into the skill`,
    )
  })

  test('prompt 模板保留两个占位符（工作流节点靠它们填参）', () => {
    expect(MERGER_PROMPT_TEMPLATE).toContain('{{intent}}')
    expect(MERGER_PROMPT_TEMPLATE).toContain('{{memories}}')
  })

  test('记忆清单的序列化格式没变（它是 agent 看到的输入）', () => {
    expect(
      serializeMemoriesForPrompt([
        { id: 'm1', title: 'T', bodyMd: 'B', scopeType: 'global' },
        { id: 'm2', title: 'U', bodyMd: 'C', scopeType: 'repo' },
      ]),
    ).toBe(
      '### Memory m1\n**T** _(scope: global)_\n\nB\n\n### Memory m2\n**U** _(scope: repo)_\n\nC',
    )
  })
})

describe('RFC-353 T4 — 内建工作流图', () => {
  // id / name 由调用方注入（domain 不去 legacy 取），这里给一组测试身份即可。
  const def = canonicalFusionWorkflowDefinition({
    workflowId: 'wf_fusion',
    workflowName: 'aw-skill-fusion',
    mergerAgentId: 'agt_merger',
    mergerAgentName: 'aw-skill-merger',
  })

  test('节点 id 与种类逐字不变', () => {
    expect(def.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual([
      'in_intent:input',
      'in_memories:input',
      'merger:agent-single',
      'clarify:clarify',
    ])
  })

  test('clarify 回边成对存在——缺了它融合就不再必答澄清', () => {
    const edges = def.edges.map(
      (e) => `${e.source.nodeId}.${e.source.portName}→${e.target.nodeId}.${e.target.portName}`,
    )
    expect(edges).toContain('merger.__clarify__→clarify.questions')
    expect(edges).toContain('clarify.answers→merger.__clarify_response__')
  })

  test('两个输入都在，且 memories 必填', () => {
    expect(def.inputs.map((i) => `${i.key}:${i.required === true}`)).toEqual([
      'intent:false',
      'memories:true',
    ])
  })
})

describe('RFC-353 T4 — 状态机逐字不变', () => {
  test('允许的转移与迁移前完全一致', () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ['running', 'awaiting_approval'],
      ['running', 'failed'],
      ['running', 'canceled'],
      ['awaiting_approval', 'applying'],
      ['awaiting_approval', 'running'],
      ['awaiting_approval', 'canceled'],
      ['awaiting_approval', 'failed'],
      ['applying', 'done'],
      ['applying', 'failed'],
    ]
    for (const [from, to] of allowed) {
      expect(`${from}→${to}:${isValidFusionTransition(from as never, to as never)}`).toBe(
        `${from}→${to}:true`,
      )
    }
  })

  test('终态出不去，且 applying 不能倒回 awaiting_approval', () => {
    for (const from of ['done', 'canceled', 'failed', 'rejected'] as const) {
      expect(`${from}:${isValidFusionTransition(from, 'running')}`).toBe(`${from}:false`)
    }
    expect(isValidFusionTransition('applying', 'awaiting_approval')).toBe(false)
    expect(isValidFusionTransition('running', 'applying')).toBe(false)
  })
})
