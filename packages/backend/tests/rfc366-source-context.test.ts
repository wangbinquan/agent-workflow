// RFC-366 —— 两类新源喂给蒸馏器的**内容**。
//
// 覆盖 proposal §7 的 AC-13 / AC-14，外加三条错误路径。这里断言的是
// `buildDistillerUserPrompt` 的输出文本：prompt 是生产代码
// （`docs/dev-gotchas.md`「给模型的 prompt 就是生产代码」），块少了一段、
// 顺序换了一下，都是产品行为变化而不是排版问题。
//
// 特别锁住 D6 的那条取舍：task-run 块**不含** transcript。本任务里每个 agent
// 的会话已经各自作为 agent-run 源喂过一遍，重复搬运就是把同一批 token 付两次。

import { describe, expect, test } from 'bun:test'
import { DEFAULT_SOURCE_CONTEXT_BUDGET } from '@agent-workflow/shared'
import {
  buildDistillerUserPrompt,
  type LoadedSourceEvents,
} from '../src/modules/memory/application/distill/memoryDistiller'

const EMPTY: LoadedSourceEvents = {
  clarify: [],
  review: [],
  feedback: [],
  agentRun: [],
  taskRun: [],
}

function agentRun(
  overrides: Partial<LoadedSourceEvents['agentRun'][number]> = {},
): LoadedSourceEvents['agentRun'][number] {
  return {
    id: 'nr-1',
    taskId: 't-1',
    nodeId: 'agent-a',
    agentName: 'writer',
    status: 'done',
    durationMs: 4242,
    failureCode: null,
    errorMessage: null,
    promptMd: 'PROMPT-MARKER',
    injectedMemories: [],
    injectedMemoriesReason: null,
    transcriptMd: 'TRANSCRIPT-MARKER',
    transcriptReason: null,
    outputs: [{ portName: 'diff', kind: 'text', content: 'OUTPUT-MARKER' }],
    ...overrides,
  }
}

function taskRun(
  overrides: Partial<LoadedSourceEvents['taskRun'][number]> = {},
): LoadedSourceEvents['taskRun'][number] {
  return {
    id: 't-1',
    name: 'nightly-fix',
    status: 'failed',
    durationMs: 9000,
    errorSummary: 'SUMMARY-MARKER',
    errorMessage: 'ERROR-MARKER',
    failedNodeId: 'agent-b',
    inputsMd: '{"INPUT":"MARKER"}',
    nodeOutcomes: [
      { nodeId: 'agent-a', status: 'done', retryIndex: 0 },
      { nodeId: 'agent-b', status: 'failed', retryIndex: 2 },
    ],
    finalOutputs: [{ nodeId: 'out-1', portName: 'result', content: 'FINAL-MARKER' }],
    ...overrides,
  }
}

const prompt = (events: Partial<LoadedSourceEvents>): string =>
  buildDistillerUserPrompt({
    events: { ...EMPTY, ...events },
    scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
    taskId: 't-1',
    sourceContextBudget: DEFAULT_SOURCE_CONTEXT_BUDGET,
  })

describe('RFC-366 agent-run 块（AC-13）', () => {
  test('三块齐全：已注入记忆 / transcript / 输出，外加身份与 prompt', () => {
    const text = prompt({
      agentRun: [
        agentRun({
          injectedMemories: [{ scopeType: 'repo', title: 'KNOWN-TITLE', bodyMdHead: 'KNOWN-BODY' }],
        }),
      ],
    })
    expect(text).toContain('## Finished agent runs')
    expect(text).toContain('### agent-run:nr-1 (agent writer, node agent-a, status=done)')
    expect(text).toContain('Duration: 4242ms')
    expect(text).toContain('PROMPT-MARKER')
    expect(text).toContain('Memories already injected into this run')
    expect(text).toContain('[repo] KNOWN-TITLE — KNOWN-BODY')
    expect(text).toContain('TRANSCRIPT-MARKER')
    expect(text).toContain('port "diff" (text): OUTPUT-MARKER')
  })

  test('已注入记忆排在 transcript 之前——模型读过程时上文已有「已知」清单', () => {
    const text = prompt({
      agentRun: [
        agentRun({
          injectedMemories: [{ scopeType: 'agent', title: 'KNOWN', bodyMdHead: '' }],
        }),
      ],
    })
    expect(text.indexOf('Memories already injected into this run')).toBeLessThan(
      text.indexOf('Agent transcript:'),
    )
  })

  test('解析不出 agent 名时退回节点 id，不留空', () => {
    const text = prompt({ agentRun: [agentRun({ agentName: null })] })
    expect(text).toContain('### agent-run:nr-1 (agent agent-a, node agent-a, status=done)')
  })

  test('失败的运行带上 failureCode 与错误正文', () => {
    const text = prompt({
      agentRun: [
        agentRun({ status: 'failed', failureCode: 'runtime-spawn', errorMessage: 'BOOM-MARKER' }),
      ],
    })
    expect(text).toContain('status=failed')
    expect(text).toContain('Failure code: runtime-spawn')
    expect(text).toContain('BOOM-MARKER')
  })

  // --- 错误路径：每一块各自降级，不连坐 ---
  test('transcript 不可用时打占位符，其余块照常', () => {
    const text = prompt({
      agentRun: [
        agentRun({
          transcriptMd: null,
          transcriptReason: 'no events captured for source node_run',
        }),
      ],
    })
    expect(text).toContain('(agent transcript unavailable: no events captured for source node_run)')
    expect(text).toContain('OUTPUT-MARKER')
  })

  test('已注入记忆不可读时打占位符，transcript 照常', () => {
    const text = prompt({
      agentRun: [agentRun({ injectedMemoriesReason: 'unreadable: unexpected snapshot shape' })],
    })
    expect(text).toContain(
      'Memories already injected into this run: (unreadable: unexpected snapshot shape)',
    )
    expect(text).toContain('TRANSCRIPT-MARKER')
  })

  test('没有输出端口时不打空的 Outputs 段', () => {
    const text = prompt({ agentRun: [agentRun({ outputs: [] })] })
    expect(text).not.toContain('Outputs:')
  })
})

describe('RFC-366 task-run 块（AC-14）', () => {
  test('摘要 / 入参 / 节点终态表 / 最终输出齐全', () => {
    const text = prompt({ taskRun: [taskRun()] })
    expect(text).toContain('## Finished task executions')
    expect(text).toContain('### task-run:t-1 (nightly-fix, status=failed)')
    expect(text).toContain('Duration: 9000ms')
    expect(text).toContain('Failed node: agent-b')
    expect(text).toContain('Error summary: SUMMARY-MARKER')
    expect(text).toContain('ERROR-MARKER')
    expect(text).toContain('MARKER')
    expect(text).toContain('- agent-b: failed (retry 2)')
    expect(text).toContain('node "out-1" port "result": FINAL-MARKER')
  })

  test('D6：task-run 块不含 transcript（不与 agent-run 重复付费）', () => {
    const text = prompt({ taskRun: [taskRun()], agentRun: [agentRun()] })
    const taskSection = text.slice(text.indexOf('## Finished task executions'))
    expect(taskSection).not.toContain('Agent transcript:')
    expect(taskSection).not.toContain('TRANSCRIPT-MARKER')
    // 而 agent-run 那一段是有的——两段各司其职。
    expect(text).toContain('TRANSCRIPT-MARKER')
  })

  test('成功收场的任务不打失败字段', () => {
    const text = prompt({
      taskRun: [
        taskRun({ status: 'done', failedNodeId: null, errorSummary: null, errorMessage: null }),
      ],
    })
    expect(text).toContain('status=done')
    expect(text).not.toContain('Failed node:')
    expect(text).not.toContain('Error summary:')
  })
})

describe('RFC-366 — 两类新源为空时 prompt 与 RFC-041 基线同形', () => {
  test('都为空则不出现任何新块标题', () => {
    const text = prompt({ feedback: [{ id: 'f1', taskId: 't-1', bodyMd: 'note', createdAt: 1 }] })
    expect(text).toContain('## Task feedback notes')
    expect(text).not.toContain('## Finished agent runs')
    expect(text).not.toContain('## Finished task executions')
  })
})
