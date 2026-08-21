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
import {
  WORKFLOW_SCHEMA_VERSION,
  WEBHOOK_TEMPLATE_VARS,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { CodeHostCallEdit } from '../src/components/canvas/inspector/CodeHostCallEdit'
import type { InspectorChangeMeta } from '../src/components/canvas/inspector/historyMeta'
import type { RuntimeTriggerParameterContract } from '../src/components/runtime-parameters/catalog'

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
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [node()],
  edges: [],
}

const TRIGGER_CONTRACTS: RuntimeTriggerParameterContract[] = [
  {
    namespace: 'webhook',
    definitionRef: { id: 'code-host.webhook.note', revision: 1 },
    sourceLabel: 'Code-host webhook',
    groupLabel: 'Code-host event',
    fields: WEBHOOK_TEMPLATE_VARS.map((fieldId) => ({
      fieldId,
      label:
        fieldId === 'comment_thread_id'
          ? 'Comment thread ID'
          : fieldId === 'event_json'
            ? 'Event JSON'
            : fieldId === 'mr_iid'
              ? 'MR / PR number'
              : fieldId,
      description: `Code-host event field ${fieldId}`,
    })),
  },
]

function renderEdit(
  n: WorkflowNode = node(),
  definition: WorkflowDefinition = { ...DEFINITION, nodes: [n] },
) {
  const patched: WorkflowNode[] = []
  const metas: InspectorChangeMeta[] = []
  const view = render(
    <CodeHostCallEdit
      node={n}
      agents={[]}
      definition={definition}
      triggerContracts={TRIGGER_CONTRACTS}
      onPatch={(next, meta) => {
        patched.push(next)
        metas.push(meta)
      }}
      onHistoryBoundary={() => {}}
      onCommitDef={() => {}}
      onTransition={() => {}}
    />,
  )
  return { ...view, patched, metas }
}

function definitionWithInput(
  n: WorkflowNode,
  targetPortName: string,
  sourcePortName = 'result',
): WorkflowDefinition {
  const source = {
    id: 'audit-agent',
    kind: 'agent-single',
    agentName: 'Code auditor',
  } as WorkflowNode
  return {
    ...DEFINITION,
    nodes: [source, n],
    edges: [
      {
        id: 'edge-input',
        source: { nodeId: source.id, portName: sourcePortName },
        target: { nodeId: n.id, portName: targetPortName },
      },
    ],
  }
}

function chooseRuntimeParameter(pickerTestId: string, query: string, name: RegExp): void {
  const picker = screen.getByTestId(pickerTestId)
  fireEvent.pointerDown(picker, { button: 0 })
  fireEvent.click(picker)
  fireEvent.change(screen.getByRole('combobox', { name: /Search parameter|搜索参数/ }), {
    target: { value: query },
  })
  fireEvent.click(screen.getByRole('option', { name }))
}

describe('RFC-269 Inspector', () => {
  test('连入输出后显式显示 source → 本地变量，并从目标字段的公共 picker 插入', () => {
    const n = node({ action: 'comment.create', params: { mr: '18', body: '' } })
    const { patched } = renderEdit(n, definitionWithInput(n, 'review_body'))

    expect(screen.getByTestId('code-host-input-guide').textContent).toContain(
      '1 input(s) still need a parameter',
    )
    expect(screen.getByTestId('code-host-input-binding-review_body').textContent).toContain(
      'Code auditor · result',
    )
    expect(screen.getByTestId('code-host-input-token-review_body').textContent).toBe(
      '{{review_body}}',
    )

    chooseRuntimeParameter(
      'code-host-runtime-parameter-param-body',
      'review_body',
      /Input port: review_body/i,
    )

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect((latest.params as Record<string, string>).body).toBe('{{review_body}}')
  })

  test('枚举参数通过同一 picker 整值替换上游输入 token', () => {
    const n = node({
      action: 'commit-status.set',
      params: { sha: 'abc123', state: 'pending' },
    })
    const { patched } = renderEdit(n, definitionWithInput(n, 'verdict'))

    chooseRuntimeParameter(
      'code-host-runtime-parameter-param-state',
      'verdict',
      /Input port: verdict/i,
    )

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect((latest.params as Record<string, string>).state).toBe('{{verdict}}')
  })

  test('存量枚举模板可见但不是伪造的业务选项，选择字面量后正常替换', () => {
    const saved = '{{trigger.webhook.comment_author}}'
    const { patched } = renderEdit(
      node({
        action: 'commit-status.set',
        params: { sha: 'abc123', state: saved },
      }),
    )

    const trigger = screen.getByTestId('code-host-field-state')
    expect(trigger.textContent).toContain(saved)
    fireEvent.click(trigger)
    expect(
      screen.getAllByRole('option').some((option) => option.textContent?.includes(saved) === true),
    ).toBe(false)

    fireEvent.mouseDown(screen.getByRole('option', { name: /pending/i }))
    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect((latest.params as Record<string, string>).state).toBe('pending')
  })

  test('当前操作不执行的存量值保持可见，并经确认以单次历史操作清理', () => {
    const { patched, metas } = renderEdit(
      node({
        action: 'comment.create',
        params: { mr: '18', body: 'active', state: '{{trigger.webhook.pipeline_status}}' },
        request: {
          method: 'POST',
          path: '/inactive/{{trigger.webhook.branch}}',
          query: { q: '{{trigger.webhook.comment_text}}' },
          body: '{{trigger.webhook.event_json}}',
        },
      }),
    )

    expect(screen.getByTestId('code-host-inactive-values').textContent).toContain(
      '4 saved value(s) are not used by this action',
    )
    expect(screen.getByTestId('code-host-inactive-value-param-state').textContent).toContain(
      '{{trigger.webhook.pipeline_status}}',
    )
    expect(screen.queryByTestId('code-host-inactive-value-param-body')).toBeNull()

    const clear = screen.getByTestId('code-host-clear-inactive-param-state')
    fireEvent.click(clear)
    expect(patched).toEqual([])
    expect(clear.textContent).toContain('Confirm clear')
    fireEvent.click(clear)

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect(latest.params).toEqual({ mr: '18', body: 'active' })
    expect(metas.at(-1)).toMatchObject({ source: 'inspector', transaction: 'single' })
  })

  test('切回匹配动作后，保留的存量参数恢复为可编辑目标', () => {
    renderEdit(
      node({
        action: 'commit-status.set',
        params: { sha: 'abc123', state: '{{trigger.webhook.pipeline_status}}' },
      }),
    )

    expect(screen.queryByTestId('code-host-inactive-value-param-state')).toBeNull()
    expect(screen.getByTestId('code-host-field-state').textContent).toContain(
      '{{trigger.webhook.pipeline_status}}',
    )
  })

  test('未连输入时明确给出下一步，而不是显示空变量面板', () => {
    renderEdit()
    expect(screen.getByTestId('code-host-input-guide').textContent).toContain(
      'No upstream input connected',
    )
  })

  test('已写入参数的输入显示完成态与可移除目标', () => {
    const n = node({
      action: 'comment.create',
      params: { mr: '18', body: '{{review_body}}' },
    })
    const { patched } = renderEdit(n, definitionWithInput(n, 'review_body'))

    expect(screen.getByTestId('code-host-input-guide').textContent).toContain('Inputs are bound')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove the binding from input review_body to parameter Body',
      }),
    )
    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect((latest.params as Record<string, string>).body).toBe('')
  })

  test('动作下拉按类别分组呈现', () => {
    renderEdit()
    expect(screen.getByText(/Add a reply to an existing code-review discussion/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('code-host-action'))
    // 分组表头由公共 <Select> 的 group 能力渲染（零组件改动即满足 Q5）。
    // 断言结构而不是文案：测试环境的语言不该决定这条锁成不成立。
    const headers = document.querySelectorAll('.select__group')
    expect(headers.length).toBe(5)
    expect(screen.getByTestId('code-host-action-search')).toBeTruthy()
    expect(screen.getByRole('option', { name: /top-level comment ID/i })).toBeTruthy()
  })

  test('动作可按业务词搜索，不用在 20 个接口里逐个翻', () => {
    renderEdit()
    fireEvent.click(screen.getByTestId('code-host-action'))
    fireEvent.change(screen.getByTestId('code-host-action-search'), {
      target: { value: 'workflow' },
    })

    expect(screen.getByRole('option', { name: /Start pipeline \/ workflow/i })).toBeTruthy()
    expect(
      screen.queryByRole('option', { name: /Reply to existing review discussion/i }),
    ).toBeNull()
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

  test('触发上下文按需进入目标字段 picker，不在默认面平铺', () => {
    renderEdit()
    expect(screen.queryByText('{{trigger.webhook.mr_iid}}')).toBeNull()
    fireEvent.click(screen.getByTestId('code-host-runtime-parameter-param-mr'))
    fireEvent.change(screen.getByRole('combobox', { name: /Search parameter|搜索参数/ }), {
      target: { value: 'trigger.webhook.' },
    })
    expect(screen.getByText('{{trigger.webhook.mr_iid}}')).toBeTruthy()
    expect(screen.getByText('{{trigger.webhook.comment_thread_id}}')).toBeTruthy()
    expect(screen.getByText('{{trigger.webhook.event_json}}')).toBeTruthy()
  })

  test('凭据配置入口在新标签页打开，不会把作者从当前草稿带走', () => {
    renderEdit()
    const link = screen.getByTestId('code-host-manage-connections')
    expect(link.getAttribute('href')).toBe('/settings?tab=codeHosts')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  test('字段旁 picker 插入该字段的光标处，不依赖最近聚焦猜测', () => {
    const { patched } = renderEdit(node({ params: { body: 'Review: ' } }))
    const body = screen.getByTestId('code-host-field-body') as HTMLTextAreaElement
    body.setSelectionRange(body.value.length, body.value.length)
    chooseRuntimeParameter(
      'code-host-runtime-parameter-param-body',
      'comment_thread_id',
      /Comment thread ID/i,
    )

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect((latest.params as Record<string, string>).body).toBe(
      'Review: {{trigger.webhook.comment_thread_id}}',
    )
  })

  test('custom query value 是可编辑、可聚焦的 canonical trigger 插入目标', () => {
    const { patched } = renderEdit(
      node({
        action: 'custom',
        request: {
          method: 'GET',
          path: '/projects/1/merge_requests',
          query: { iid: 'MR: ' },
        },
      }),
    )
    const value = screen.getByTestId('code-host-query-value-iid') as HTMLInputElement
    value.setSelectionRange(value.value.length, value.value.length)
    chooseRuntimeParameter(
      'code-host-runtime-parameter-request-query-iid',
      'mr_iid',
      /MR \/ PR number/i,
    )

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect(latest.request).toMatchObject({
      query: { iid: 'MR: {{trigger.webhook.mr_iid}}' },
    })
  })

  test('关闭破坏性方法权限时同步把已选 DELETE 退回 GET', () => {
    const { patched } = renderEdit(
      node({
        action: 'custom',
        allowDestructive: true,
        request: { method: 'DELETE', path: '/projects/example' },
      }),
    )

    fireEvent.click(screen.getByTestId('code-host-allow-destructive'))

    const latest = patched[patched.length - 1] as unknown as Record<string, unknown>
    expect(latest.allowDestructive).toBe(false)
    expect(latest.request).toMatchObject({ method: 'GET', path: '/projects/example' })
  })
})
