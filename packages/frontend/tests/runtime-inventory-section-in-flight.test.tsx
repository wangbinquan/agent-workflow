// RFC-062: the RuntimeInventorySection must render the new in-flight reason
// distinctly from file-missing, and the text must NOT blame the dump plugin
// (the whole point of the new reason). Three locking concerns:
//   - zh-CN + en-US text exists and renders
//   - DOM anchor `data-testid="inventory-missing"` is preserved across locales
//     so DOM-based assertions in other test files keep working
//   - text does not contain '插件' (zh) or 'plugin' (en) — protects the
//     product intent "don't accuse the plugin when it's actually fine"

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18next from 'i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InventorySnapshot } from '@agent-workflow/shared'
import { RuntimeInventorySection } from '../src/components/inventory/RuntimeInventorySection'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'
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

function mockInventory(taskId: string, nodeRunId: string, body: InventorySnapshot): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req) => {
    const url = typeof req === 'string' ? req : req.toString()
    if (url.includes(`/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)) {
      return new Response(JSON.stringify(body), {
        status: 200,
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

const IN_FLIGHT_SNAPSHOT: InventorySnapshot = {
  captured: false,
  reason: 'in-flight',
  message: null,
}

describe('RFC-062 RuntimeInventorySection — in-flight reason', () => {
  test('zh-CN renders 正在运行 / 生成中 text inside the expanded details', async () => {
    await i18next.changeLanguage('zh-CN')
    mockInventory('t1', 'r1', IN_FLIGHT_SNAPSHOT)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    fireEvent.click(det.querySelector('summary')!)
    await waitFor(() => {
      const node = screen.queryByTestId('inventory-missing')
      expect(node).not.toBeNull()
      expect(node?.textContent ?? '').toContain('生成中')
    })
  })

  test('en-US renders Run in progress / inventory generating text', async () => {
    await i18next.changeLanguage('en-US')
    mockInventory('t1', 'r1', IN_FLIGHT_SNAPSHOT)
    render(
      withQc(
        <RuntimeInventorySection taskId="t1" nodeRunId="r1" workflowNodeKind="agent-single" />,
      ),
    )
    const det = await screen.findByTestId('runtime-inventory-section')
    fireEvent.click(det.querySelector('summary')!)
    await waitFor(() => {
      const node = screen.queryByTestId('inventory-missing')
      expect(node).not.toBeNull()
      const text = (node?.textContent ?? '').toLowerCase()
      expect(text).toContain('in progress')
      expect(text).toContain('inventory')
    })
  })

  test('data-testid="inventory-missing" anchor is preserved (no chips for in-flight)', async () => {
    await i18next.changeLanguage('zh-CN')
    mockInventory('t1', 'r1', IN_FLIGHT_SNAPSHOT)
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
    // chips only appear for captured snapshots — none here.
    expect(screen.queryByTestId('inventory-chips')).toBeNull()
  })

  test('product invariant: in-flight text does NOT blame the plugin', () => {
    // Direct i18n bundle assertion — protects against future "let's reuse
    // the file-missing wording" simplifications that would reintroduce the
    // misleading 'plugin may have failed' phrasing.
    const zh = zhCN.nodeDrawer.inventory.reason['in-flight']
    const en = enUS.nodeDrawer.inventory.reason['in-flight']
    expect(zh.length).toBeGreaterThan(0)
    expect(en.length).toBeGreaterThan(0)
    expect(zh).not.toContain('插件')
    expect(en.toLowerCase()).not.toContain('plugin')
  })
})
