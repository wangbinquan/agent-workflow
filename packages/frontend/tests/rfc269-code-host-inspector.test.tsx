// RFC-269 — 前端两处不能回归的行为：
//
//   1. **动作按类别分组呈现**（用户拍板 Q5）。19 个动作平铺成一列没法用。
//   2. **不支持的动作置灰而不是隐藏**。GitHub 的 resolve 线程在 REST 面根本
//      不存在；隐藏它会让人以为「GitHub 没这功能」，然后跑去自定义请求里瞎试。
//
// 另加一条表单由注册表驱动的锁：切换 provider 后，只对某一家显示的字段
// （GitHub 的 workflow 文件名）要跟着出现/消失 —— 那正是「表单知识只有一份」
// 的可观察证据。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { CodeHostCallEdit } from '../src/components/canvas/inspector/CodeHostCallEdit'

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
      source: 'session',
      permissions: ['code-host-calls:author'],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => true,
}))

afterEach(() => {
  cleanup()
})

function node(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'ch1',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.reply-thread',
    params: {},
    ...extra,
  } as WorkflowNode
}

const DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [node()],
  edges: [],
}

function renderEdit(n: WorkflowNode = node()) {
  const patched: WorkflowNode[] = []
  const view = render(
    <CodeHostCallEdit
      node={n}
      agents={[]}
      definition={{ ...DEFINITION, nodes: [n] }}
      onPatch={(next) => {
        patched.push(next)
      }}
      onHistoryBoundary={() => {}}
      onCommitDef={() => {}}
      onTransition={() => {}}
    />,
  )
  return { ...view, patched }
}

describe('RFC-269 Inspector', () => {
  test('动作下拉按类别分组呈现', () => {
    renderEdit()
    fireEvent.click(screen.getByTestId('code-host-action'))
    // 分组表头由公共 <Select> 的 group 能力渲染（零组件改动即满足 Q5）。
    // 断言结构而不是文案：测试环境的语言不该决定这条锁成不成立。
    const headers = document.querySelectorAll('.select__group')
    expect(headers.length).toBe(5)
  })

  test('GitHub 下 resolve 线程置灰且给出原因，而不是从列表里消失', () => {
    renderEdit(node({ provider: 'github' }))
    fireEvent.click(screen.getByTestId('code-host-action'))
    const option = screen.getByRole('option', { name: /resolve/i })
    expect(option).toBeTruthy()
    expect(option.getAttribute('aria-disabled')).toBe('true')
  })

  test('表单字段随 provider 变化 —— 只对 GitHub 显示的工作流文件名', () => {
    const gitlab = renderEdit(node({ action: 'pipeline.trigger' }))
    expect(screen.queryByTestId('code-host-field-workflow')).toBeNull()
    gitlab.unmount()
    renderEdit(node({ action: 'pipeline.trigger', provider: 'github' }))
    expect(screen.getByTestId('code-host-field-workflow')).toBeTruthy()
  })

  test('触发上下文变量原样列出，作者不用去翻文档', () => {
    renderEdit()
    const chips = screen.getByTestId('code-host-trigger-vars')
    expect(chips.textContent).toContain('{{trigger.mr_iid}}')
    expect(chips.textContent).toContain('{{trigger.comment_thread_id}}')
    // event_json 不在触发上下文里（design D15）。
    expect(chips.textContent).not.toContain('event_json')
  })
})
