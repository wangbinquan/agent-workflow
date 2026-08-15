// RFC-261 — DeliveriesPanel 分页 + 事件/仓库过滤集成锁（proposal AC-6/7/8）：
//   封套消费（总数展示）、上下页 / 直接跳页请求 page=N、过滤变更携带参数且页码复位 1、
//   仓库下拉选项来自 /repos、越界页钳回、只读（canReplay=false）下过滤分页照常。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { DeliveriesPanel } from '../src/components/webhooks/DeliveriesPanel'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const ROW = {
  id: 'dl1',
  endpointId: 'ep1',
  eventUuid: 'uuid-1',
  attemptCount: 1,
  gitlabEventHeader: 'Push Hook',
  objectKind: 'push',
  eventType: 'push',
  repoPath: 'acme/api',
  streamHint: 'acme/api|branch:main',
  status: 'matched',
  statusReason: null,
  replayedFromDeliveryId: null,
  receivedAt: 1700000000000,
}

let requests: URL[] = []
/** 打开后：page>=3 的列表响应模拟数据缩水（pageCount 掉到 1），触发钳制。 */
let shrinkAtPage3 = false
let responseTotal = 120
let responsePageCount = 3

function listRequests(): URL[] {
  return requests.filter((u) => u.pathname.endsWith('/api/webhook-deliveries'))
}

beforeEach(async () => {
  requests = []
  shrinkAtPage3 = false
  responseTotal = 120
  responsePageCount = 3
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc261-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const u = new URL(typeof input === 'string' ? input : (input as URL | Request).toString())
    requests.push(u)
    if (u.pathname.endsWith('/api/webhook-deliveries/repos')) {
      return jsonResponse(['acme/api', 'acme/web'])
    }
    if (u.pathname.endsWith('/api/webhook-deliveries')) {
      const page = Number(u.searchParams.get('page') ?? '1')
      if (shrinkAtPage3 && page >= 3) {
        return jsonResponse({ items: [], total: 40, page, pageCount: 1 })
      }
      return jsonResponse({
        items: [ROW],
        total: responseTotal,
        page,
        pageCount: responsePageCount,
      })
    }
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(canReplay = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DeliveriesPanel canReplay={canReplay} />
    </QueryClientProvider>,
  )
}

function pageBtn(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

async function pickOption(comboboxName: string, optionText: string): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name: comboboxName }))
  const option = await waitFor(() => {
    const list = document.querySelector('ul[role="listbox"]')
    if (list === null) throw new Error('listbox not opened')
    const found = Array.from(list.querySelectorAll('li[role="option"]')).find(
      (candidate) => (candidate.textContent ?? '') === optionText,
    )
    if (found === undefined) throw new Error(`option '${optionText}' not ready`)
    return found
  })
  fireEvent.mouseDown(option)
}

describe('RFC-261 · 投递面板分页与过滤', () => {
  test('封套消费：总数 + 分页控件；只读视图下照常、无 replay（AC-6/8）', async () => {
    mount(false)
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    expect(screen.getByTestId('webhook-deliveries-total').textContent).toBe('120 total')
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    expect(pageBtn('Previous').disabled).toBe(true)
    expect(pageBtn('Next').disabled).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Filter by event type' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Filter by repository' })).toBeTruthy()
    expect(screen.queryByTestId('webhook-delivery-replay-dl1')).toBeNull()
  })

  test('UI 修订：筛选栏是一个 group，两个下拉带可见维度标签（选中后值会盖掉语义）', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    const bar = screen.getByRole('group', { name: 'Delivery filters' })
    expect(screen.getByTestId('webhook-deliveries-filters')).toBe(bar)
    // 三个筛选控件同属一族（此前两个下拉靠 space-between 甩在右侧）
    for (const name of ['Filter by status', 'Filter by event type', 'Filter by repository']) {
      const control = screen.getByRole(name === 'Filter by status' ? 'radiogroup' : 'combobox', {
        name,
      })
      expect(bar.contains(control)).toBe(true)
    }
    // 表头也叫 Event/Repository——限定在筛选栏内找可见维度标签
    const eventLabel = within(bar).getByText('Event')
    const repoLabel = within(bar).getByText('Repository')
    expect(eventLabel.className).toContain('filter-bar__label')
    expect(repoLabel.className).toContain('filter-bar__label')
    // 总数从下拉旁边挪到表格上方的 meta 行
    const total = screen.getByTestId('webhook-deliveries-total')
    expect(total.className).toContain('webhook-deliveries__meta')
    expect(bar.contains(total)).toBe(false)
  })

  test('UI 修订：清除筛选——无筛选时不渲染，激活后出现，点击复位三过滤与页码', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    expect(screen.queryByTestId('webhook-deliveries-clear-filters')).toBeNull()

    await pickOption('Filter by event type', 'Pipeline failed')
    await pickOption('Filter by repository', 'acme/web')
    // 换 queryKey 会有一帧 loading（表格与分页暂时不渲染），等数据回来再翻页
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    fireEvent.click(pageBtn('Next'))
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy())
    const clear = await waitFor(() => screen.getByTestId('webhook-deliveries-clear-filters'))

    requests = []
    fireEvent.click(clear)
    await waitFor(() => {
      const after = listRequests()
      expect(after.length).toBeGreaterThan(0)
      const last = after[after.length - 1]!
      expect(last.searchParams.get('eventType')).toBeNull()
      expect(last.searchParams.get('repoPath')).toBeNull()
      expect(last.searchParams.get('status')).toBeNull()
      expect(last.searchParams.get('page')).toBe('1')
    })
    expect(screen.queryByTestId('webhook-deliveries-clear-filters')).toBeNull()
  })

  test('下一页 → 请求 page=2 且页码文案更新（AC-6）', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    fireEvent.click(pageBtn('Next'))
    await waitFor(() =>
      expect(listRequests().some((u) => u.searchParams.get('page') === '2')).toBe(true),
    )
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy())
    expect(pageBtn('Previous').disabled).toBe(false)
  })

  test('几百页时可直接跳转，请求指定 page 并更新页码文案', async () => {
    responseTotal = 15_000
    responsePageCount = 300
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())

    const input = screen.getByRole('spinbutton', { name: 'Page number' })
    fireEvent.change(input, { target: { value: '237' } })
    fireEvent.click(pageBtn('Go to page'))

    await waitFor(() =>
      expect(listRequests().some((u) => u.searchParams.get('page') === '237')).toBe(true),
    )
    await waitFor(() => expect(screen.getByText('Page 237 of 300')).toBeTruthy())
  })

  test('事件过滤 → 请求带 eventType 且页码复位 1（AC-6）', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    fireEvent.click(pageBtn('Next'))
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy())
    await pickOption('Filter by event type', 'Pipeline failed')
    await waitFor(() => {
      const withEvent = listRequests().filter(
        (u) => u.searchParams.get('eventType') === 'pipeline_failed',
      )
      expect(withEvent.length).toBeGreaterThan(0)
      // 过滤变更后的每个请求都从第 1 页开始
      expect(withEvent.every((u) => u.searchParams.get('page') === '1')).toBe(true)
    })
  })

  test('仓库过滤：选项来自 /repos（含「全部」）→ 请求带 repoPath（AC-6）', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    await waitFor(() =>
      expect(requests.some((u) => u.pathname.endsWith('/api/webhook-deliveries/repos'))).toBe(true),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by repository' }))
    const target = await waitFor(() => {
      const list = document.querySelector('ul[role="listbox"]')
      if (list === null) throw new Error('listbox not opened')
      const options = Array.from(list.querySelectorAll('li[role="option"]'))
      // 选中项 label 末尾带 ✓ 指示，归一后比较
      const labels = options.map((candidate) => (candidate.textContent ?? '').replace(/✓$/, ''))
      expect(labels).toEqual(['All repositories', 'acme/api', 'acme/web'])
      return options[2]!
    })
    fireEvent.mouseDown(target)
    await waitFor(() =>
      expect(listRequests().some((u) => u.searchParams.get('repoPath') === 'acme/web')).toBe(true),
    )
  })

  test('数据缩水时越界页钳回（AC-7）', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-dl1')).toBeTruthy())
    shrinkAtPage3 = true
    fireEvent.click(pageBtn('Next'))
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy())
    fireEvent.click(pageBtn('Next')) // page 3 响应 pageCount=1 → 钳回
    await waitFor(() => {
      const pages = listRequests().map((u) => u.searchParams.get('page') ?? '1')
      expect(pages).toContain('3')
      expect(pages[pages.length - 1]).toBe('1')
    })
    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeTruthy())
  })
})
