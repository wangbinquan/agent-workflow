// RFC-029 T9 — RuntimeInventorySection renders 4 tables when captured,
// reason-coded placeholder when captured:false, mini chip counters on the
// summary, and stays mounted (open state preserved) across nodeRunId changes.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InventorySnapshot } from '@agent-workflow/shared'
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
  body: InventorySnapshot,
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

const CAPTURED: InventorySnapshot = {
  captured: true,
  schemaVersion: 1,
  capturedAt: 1700000000000,
  agents: [
    {
      name: 'coder',
      mode: 'primary',
      modelProviderId: 'anthropic',
      modelId: 'claude-opus-4-7',
      source: 'inline',
    },
    {
      name: 'reviewer',
      mode: 'subagent',
      modelProviderId: null,
      modelId: null,
      source: 'project',
    },
  ],
  skills: [{ name: 'foo', source: 'managed', path: '/x/foo', description: 'do stuff' }],
  mcps: [
    { name: 'memcache', type: 'local', status: 'connected', hint: null },
    { name: 'github', type: 'remote', status: 'needs_auth', hint: 'token missing' },
  ],
  plugins: [{ specifier: 'file:///plug.mjs', source: 'inline' }],
}

describe('RuntimeInventorySection', () => {
  test('returns null for non-agent kinds (does not even open <details>)', () => {
    render(
      withQc(<RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="wrapper-git" />),
    )
    expect(screen.queryByTestId('runtime-inventory-section')).toBeNull()
  })

  test('captured: renders details + summary chips + 4 sub-tables after expand', async () => {
    mockInventory('t1', 'r1', CAPTURED)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    expect(det).toBeTruthy()
    // chips appear once the query resolves
    await waitFor(() => {
      expect(screen.queryByTestId('inventory-chips')).not.toBeNull()
    })
    // expand
    fireEvent.click(det.querySelector('summary')!)
    expect((det as HTMLDetailsElement).open).toBe(true)
    // 4 sub-tables visible
    expect(screen.getByText('coder')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('foo')).toBeTruthy()
    expect(screen.getByText('memcache')).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
    expect(screen.getByText('file:///plug.mjs')).toBeTruthy()
  })

  test('captured:false reason=parse-failed renders the reason i18n text and no chips', async () => {
    mockInventory('t1', 'r1', {
      captured: false,
      reason: 'parse-failed',
      message: null,
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    fireEvent.click(det.querySelector('summary')!)
    await waitFor(() => {
      expect(screen.queryByTestId('inventory-missing')).not.toBeNull()
    })
    expect(screen.queryByTestId('inventory-chips')).toBeNull()
  })

  test('default closed', async () => {
    mockInventory('t1', 'r1', CAPTURED)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    expect((det as HTMLDetailsElement).open).toBe(false)
  })

  test('MCP needs_auth status uses warn status chip', async () => {
    mockInventory('t1', 'r1', CAPTURED)
    const { container } = render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    fireEvent.click(det.querySelector('summary')!)
    // RFC-035: StatusBadge now renders the unified <StatusChip>, so the
    // semantic anchor is `status-chip--warn` / `--success`. The old
    // `status-badge--*` class survives only as a CSS fallback during the
    // cleanup window.
    await waitFor(() => {
      expect(container.querySelectorAll('.status-chip--warn').length).toBeGreaterThan(0)
    })
    expect(container.querySelectorAll('.status-chip--success').length).toBeGreaterThan(0)
  })

  test('captured:true with zero items in a category shows (none) placeholder', async () => {
    mockInventory('t1', 'r1', {
      captured: true,
      schemaVersion: 1,
      capturedAt: 1,
      agents: [],
      skills: [],
      mcps: [],
      plugins: [],
    })
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    fireEvent.click(det.querySelector('summary')!)
    await waitFor(() => {
      // 4 (none) placeholders rendered, one per sub-table.
      const empties = det.querySelectorAll('.inventory-section__empty')
      expect(empties.length).toBe(4)
    })
  })
})
