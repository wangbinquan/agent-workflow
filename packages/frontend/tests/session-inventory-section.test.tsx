// RuntimeInventorySection —— 展开后按 driver 表态渲染各面、summary 上的计数
// chip、缺观测时的归因文案，以及跨 nodeRunId 切换保持展开状态（RFC-029 AC-9）。
//
// RFC-297 起响应形状变为 `{observation, declaration}`，本文件同时锁住统一后的
// 两条关键行为：
//  · **opencode 的富字段一列都不许少**（AC-2）——mode / model / path / 状态 /
//    插件 specifier 逐一断言；
//  · **claude 的不支持面整块不渲染**（AC-3/B4）——「没有插件这个概念」和「加载
//    了 0 个插件」在界面上必须能区分开，后者会让人白找半天。
// 以及用户实证那个 bug 的回归锁：claude 运行时**不得**再出现「插件可能加载失败」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InventoryDeclaration, RuntimeInventoryResponse } from '@agent-workflow/shared'
import { RuntimeInventorySection } from '../src/components/inventory/RuntimeInventorySection'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mockInventory(
  taskId: string,
  nodeRunId: string,
  body: RuntimeInventoryResponse,
  status = 200,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req) => {
    const url = typeof req === 'string' ? req : req.toString()
    if (url.includes(`/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

function withQc(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

/** opencode：四个面齐全、富字段全部可观测；无 tools 面。 */
const OPENCODE_DECLARATION: InventoryDeclaration = {
  agents: {
    support: 'supported',
    fields: { mode: 'supported', model: 'supported', source: 'supported' },
  },
  skills: {
    support: 'supported',
    fields: { source: 'supported', path: 'supported', description: 'supported' },
  },
  mcps: {
    support: 'supported',
    fields: { status: 'supported', type: 'supported', hint: 'supported' },
  },
  plugins: { support: 'supported', fields: { source: 'supported' } },
  tools: { support: 'unsupported', fields: {} },
}

/** claude：按名字报告，有 tools 面，没有 plugins 这个概念。 */
const CLAUDE_DECLARATION: InventoryDeclaration = {
  agents: {
    support: 'supported',
    fields: { mode: 'unsupported', model: 'unsupported', source: 'unsupported' },
  },
  skills: {
    support: 'supported',
    fields: { source: 'unsupported', path: 'unsupported', description: 'unsupported' },
  },
  mcps: {
    support: 'supported',
    fields: { status: 'supported', type: 'unsupported', hint: 'unsupported' },
  },
  plugins: { support: 'unsupported', fields: { source: 'unsupported' } },
  tools: { support: 'supported', fields: {} },
}

const OPENCODE_CAPTURED: RuntimeInventoryResponse = {
  declaration: OPENCODE_DECLARATION,
  observation: {
    state: 'captured',
    capturedAt: 1700000000000,
    faces: {
      agents: [
        {
          key: 'coder',
          name: 'coder',
          provenance: 'injected',
          mode: 'primary',
          modelProviderId: 'anthropic',
          modelId: 'claude-opus-4-7',
          source: 'inline',
        },
        {
          key: 'reviewer',
          name: 'reviewer',
          provenance: 'ambient',
          mode: 'subagent',
          modelProviderId: null,
          modelId: null,
          source: 'project',
        },
      ],
      skills: [
        {
          key: 'foo',
          name: 'foo',
          provenance: 'injected',
          source: 'managed',
          path: '/x/foo',
          description: 'do stuff',
        },
      ],
      mcps: [
        {
          key: 'memcache',
          name: 'memcache',
          provenance: 'injected',
          type: 'local',
          status: 'connected',
          hint: null,
        },
        {
          key: 'github',
          name: 'github',
          provenance: 'injected',
          type: 'remote',
          status: 'needs_auth',
          hint: 'token missing',
        },
      ],
      plugins: [
        {
          key: 'file:///plug.mjs',
          name: 'file:///plug.mjs',
          provenance: 'ambient',
          source: 'inline',
        },
      ],
    },
  },
}

const expand = async () => {
  const det = await screen.findByTestId('runtime-inventory-section')
  fireEvent.click(det.querySelector('summary')!)
  return det as HTMLDetailsElement
}

describe('RuntimeInventorySection', () => {
  test('returns null for non-agent kinds (does not even open <details>)', () => {
    render(
      withQc(<RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="wrapper-git" />),
    )
    expect(screen.queryByTestId('runtime-inventory-section')).toBeNull()
  })

  test('opencode captured：四个面 + 全部富字段一列都不少（AC-2）', async () => {
    mockInventory('t1', 'r1', OPENCODE_CAPTURED)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    await waitFor(() => {
      expect(screen.queryByTestId('inventory-chips')).not.toBeNull()
    })
    const det = await expand()
    expect(det.open).toBe(true)
    // 名字
    expect(screen.getByText('coder')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('foo')).toBeTruthy()
    expect(screen.getByText('memcache')).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
    expect(screen.getByText('file:///plug.mjs')).toBeTruthy()
    // 富字段：mode / model / path / description / type / hint
    expect(screen.getByText('primary')).toBeTruthy()
    expect(screen.getByText('anthropic / claude-opus-4-7')).toBeTruthy()
    expect(screen.getByText('/x/foo')).toBeTruthy()
    expect(screen.getByText('do stuff')).toBeTruthy()
    expect(screen.getByText('remote')).toBeTruthy()
    expect(screen.getByText('token missing')).toBeTruthy()
  })

  test('opencode：不支持的 tools 面既不出块也不进 chips', async () => {
    mockInventory('t1', 'r1', OPENCODE_CAPTURED)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(det.querySelectorAll('.inventory-table').length).toBe(4)
    })
    // 「工」chip 出现 = 把「没有这个概念」显示成了「0 个」。
    expect(screen.queryByText(/工·/)).toBeNull()
  })

  test('claude：plugins 整块不渲染，tools 面出现（AC-3/B4）', async () => {
    mockInventory('t1', 'r1', {
      declaration: CLAUDE_DECLARATION,
      observation: {
        state: 'captured',
        capturedAt: 0,
        faces: {
          agents: [{ key: 'general-purpose', name: 'general-purpose', provenance: 'ambient' }],
          skills: [{ key: 'lint', name: 'lint', provenance: 'injected' }],
          mcps: [{ key: 'rag', name: 'rag', provenance: 'injected', status: 'connected' }],
          tools: [{ key: 'Read', name: 'Read', provenance: 'ambient' }],
        },
      },
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(screen.getByText('Read')).toBeTruthy()
    })
    // 插件块不存在——不是「显示 0 个」。（测试环境跑 en-US bundle。）
    expect(det.textContent).not.toContain('Plugins')
    // claude 不报告 mode / model / path，这些列整列不出。
    expect(det.textContent).not.toContain('Mode')
    expect(det.textContent).not.toContain('Path')
    // 但它报告 MCP 状态，这一列在。
    expect(det.textContent).toContain('Status')
  })

  test('来源对账三态渲染（injected / ambient / declared-missing）', async () => {
    mockInventory('t1', 'r1', {
      declaration: CLAUDE_DECLARATION,
      observation: {
        state: 'captured',
        capturedAt: 0,
        faces: {
          skills: [
            { key: 'mine', name: 'mine', provenance: 'injected' },
            { key: 'builtin', name: 'builtin', provenance: 'ambient' },
            { key: 'ghost', name: 'ghost', provenance: 'declared-missing' },
          ],
        },
      },
    })
    const { container } = render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(screen.getByText('ghost')).toBeTruthy()
    })
    expect(det.textContent).toContain('injected here')
    expect(det.textContent).toContain('runtime built-in')
    expect(det.textContent).toContain('declared, not loaded')
    // 「已声明未加载」与告警 banner 同色（danger）。
    expect(container.querySelectorAll('.status-chip--danger').length).toBeGreaterThan(0)
  })

  test('存量行无声明清单可对账时隐藏来源列，不显示一整列错值', async () => {
    mockInventory('t1', 'r1', {
      declaration: OPENCODE_DECLARATION,
      observation: {
        state: 'captured',
        capturedAt: 1,
        faces: { skills: [{ key: 'legacy', name: 'legacy', provenance: 'ambient' }] },
        provenanceUnavailable: true,
      },
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(screen.getByText('legacy')).toBeTruthy()
    })
    expect(det.textContent).not.toContain('runtime built-in')
  })

  test('回归锁：claude 运行时不再出现「插件可能加载失败」（用户实证的 bug）', async () => {
    mockInventory('t1', 'r1', {
      declaration: CLAUDE_DECLARATION,
      observation: { state: 'not-produced', reason: 'runtime-has-no-inventory', message: null },
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(screen.queryByTestId('inventory-missing')).not.toBeNull()
    })
    expect(det.textContent).toContain('does not provide a startup inventory')
    // 这句是用户实证 bug 的原文案（en: "the plugin may have failed to load"）。
    expect(det.textContent).not.toContain('plugin may have failed to load')
    expect(screen.queryByTestId('inventory-chips')).toBeNull()
  })

  test('malformed 归因带上观测源自己的诊断详情', async () => {
    mockInventory('t1', 'r1', {
      declaration: OPENCODE_DECLARATION,
      observation: { state: 'malformed', reason: 'parse-failed', message: 'agents() call threw' },
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(screen.queryByTestId('inventory-missing')).not.toBeNull()
    })
    expect(det.textContent).toContain('agents() call threw')
  })

  test('default closed', async () => {
    mockInventory('t1', 'r1', OPENCODE_CAPTURED)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    expect((det as HTMLDetailsElement).open).toBe(false)
  })

  test('MCP needs_auth status uses warn status chip', async () => {
    mockInventory('t1', 'r1', OPENCODE_CAPTURED)
    const { container } = render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    await expand()
    // RFC-035: StatusBadge renders the unified <StatusChip>, so the semantic
    // anchor is `status-chip--warn` / `--success`.
    await waitFor(() => {
      expect(container.querySelectorAll('.status-chip--warn').length).toBeGreaterThan(0)
    })
    expect(container.querySelectorAll('.status-chip--success').length).toBeGreaterThan(0)
  })

  test('captured 但某一面为空 → 该面显示 (none) 占位', async () => {
    mockInventory('t1', 'r1', {
      declaration: OPENCODE_DECLARATION,
      observation: {
        state: 'captured',
        capturedAt: 1,
        faces: { agents: [], skills: [], mcps: [], plugins: [] },
      },
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await expand()
    await waitFor(() => {
      expect(det.querySelectorAll('.inventory-section__empty').length).toBe(4)
    })
  })
})
