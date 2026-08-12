// RFC-270 AC-11 / AC-12 — 两个特权节点 Inspector 的无权限分支。
//
// 这是**对 RFC-253 AC-30 的显式改判**：原设计是「整块只读 + 横幅」，理由写在
// `ScriptEdit.tsx` 顶部（「you may look, you may not change」）。RFC-270 把
// 「谁能看」并进「谁能写」——脚本正文是宿主要执行的代码，服务端已经不再把它
// 下发给无权限的读者，面板渲染出来只会是一排 `***`。
//
// 既有的 `rfc253-script-snippet-inspector.test.tsx` / `rfc269-code-host-inspector
// .test.tsx` 都把 actor mock 成**有**权限，所以无权限分支此前零覆盖 —— 本文件补上。
//
// 断言方式刻意是「敏感文本一个字都搜不到」而不是「占位存在」：占位存在只证明多
// 渲染了一个块，搜不到才证明少渲染了那一堆输入框。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const permissions = vi.hoisted(() => ({ current: [] as string[] }))

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
      source: 'session',
      permissions: permissions.current,
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: (perm: string) => permissions.current.includes(perm),
}))

const { ScriptEdit } = await import('../src/components/canvas/inspector/ScriptEdit')
const { CodeHostCallEdit } = await import('../src/components/canvas/inspector/CodeHostCallEdit')
const { NodeInspector } = await import('../src/components/canvas/NodeInspector')

afterEach(() => {
  cleanup()
  permissions.current = []
})

const SCRIPT_BODY = 'print("audit secret")'
const SCRIPT_DEP = 'requests==2.31.0'
const CALL_PATH = '/api/v4/projects/1/merge_requests/2/notes'

const scriptNode = {
  id: 's1',
  kind: 'script',
  language: 'python',
  script: SCRIPT_BODY,
  dependencies: [SCRIPT_DEP],
  env: { API_TOKEN: 'sk-live-nope' },
} as unknown as WorkflowNode

const callNode = {
  id: 'c1',
  kind: 'code-host-call',
  provider: 'gitlab',
  action: 'custom',
  params: { project: 'grp/app' },
  request: { method: 'POST', path: CALL_PATH, body: '{"body":"hi"}' },
} as unknown as WorkflowNode

const DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [scriptNode, callNode],
  edges: [],
}

const noop = () => {}

/** `EditProps` 的其余槽位，本文件一律不消费。 */
const editProps = {
  agents: [],
  definition: DEFINITION,
  onPatch: noop,
  onHistoryBoundary: noop,
  onCommitDef: noop,
  onTransition: noop,
}

describe('RFC-270 AC-11 · ScriptEdit 无 scripts:author', () => {
  test('渲染占位，且脚本正文 / 依赖 / env 一个字都搜不到', () => {
    render(<ScriptEdit node={scriptNode} {...editProps} />)
    expect(screen.getByTestId('script-inspector-no-view-permission')).toBeTruthy()
    expect(document.body.textContent).not.toContain(SCRIPT_BODY)
    expect(document.body.textContent).not.toContain(SCRIPT_DEP)
    expect(document.body.textContent).not.toContain('API_TOKEN')
    // 也不许留下任何可输入的控件
    expect(document.querySelectorAll('textarea, input').length).toBe(0)
    expect(screen.queryByTestId('script-env-table')).toBeNull()
  })

  test('有 scripts:author 时表单照常渲染出正文', () => {
    permissions.current = ['scripts:author']
    render(<ScriptEdit node={scriptNode} {...editProps} />)
    expect(screen.queryByTestId('script-inspector-no-view-permission')).toBeNull()
    expect(screen.getByTestId('script-env-table')).toBeTruthy()
  })
})

describe('RFC-270 AC-11 / AC-12 · CodeHostCallEdit', () => {
  test('无 code-host-calls:author：占位 + path / params 搜不到 + 没有配置入口', () => {
    render(<CodeHostCallEdit node={callNode} {...editProps} />)
    expect(screen.getByTestId('code-host-inspector-no-view-permission')).toBeTruthy()
    expect(document.body.textContent).not.toContain(CALL_PATH)
    expect(document.body.textContent).not.toContain('grp/app')
    expect(screen.queryByTestId('code-host-manage-connections')).toBeNull()
  })

  test('AC-12 有 author 但无 settings:read（manager）：面板在，但配置入口不渲染', () => {
    // manager 正是这批人 —— `MANAGER_DENIED_PERMISSIONS` 显式拒了 `settings:read`，
    // 所以今天点这个链接只会吃一个 403。
    permissions.current = ['code-host-calls:author']
    render(<CodeHostCallEdit node={callNode} {...editProps} />)
    expect(screen.queryByTestId('code-host-inspector-no-view-permission')).toBeNull()
    expect(screen.queryByTestId('code-host-manage-connections')).toBeNull()
  })

  test('AC-12 两个权限都有（admin）：配置入口渲染', () => {
    permissions.current = ['code-host-calls:author', 'settings:read']
    render(<CodeHostCallEdit node={callNode} {...editProps} />)
    const link = screen.getByTestId('code-host-manage-connections')
    expect(link.getAttribute('href')).toBe('/settings?tab=codeHosts')
  })
})

describe('RFC-270 · Preview 页签对两类特权节点根本不存在', () => {
  test('新增安全模板预览后，script/code-host 仍没有第二条泄露路径', () => {
    // RFC-292 为 call-workgroup/review 增加确定性模板预览，但特权节点仍不在
    // hasPreview 闭集内；新增 kind 时必须显式审查该边界。
    const text = readFileSync(
      join(__dirname, '..', 'src', 'components', 'canvas', 'NodeInspector.tsx'),
      'utf8',
    )
    const start = text.indexOf('const hasPreview =')
    const end = text.indexOf('const activeTab', start)
    const hasPreview = start >= 0 && end > start ? text.slice(start, end) : ''
    expect(hasPreview).toContain("node.kind === 'agent-single'")
    expect(hasPreview).toContain("node.kind === 'call-workgroup'")
    expect(hasPreview).toContain("node.kind === 'review'")
    expect(hasPreview).not.toContain("node.kind === 'script'")
    expect(hasPreview).not.toContain("node.kind === 'code-host-call'")
  })

  test('选中脚本节点时 Inspector 不出现 Preview 页签', () => {
    render(
      <NodeInspector
        definition={DEFINITION}
        selectedNodeId="s1"
        agents={[]}
        onChange={noop}
        onClose={noop}
      />,
    )
    expect(screen.queryByRole('tab', { name: /preview|预览/i })).toBeNull()
  })
})
