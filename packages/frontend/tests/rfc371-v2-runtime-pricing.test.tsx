// RFC-371 v2 §3.3 / §6 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// Settings → Runtimes → Token cost. Each runtime lists its configured model and
// every reported model; a save appends a version compared against the newest one
// the draft was based on; a conflict keeps the draft and lets the administrator
// continue from the latest version; history shows unknown rates as unpriced.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ObservationPrice,
  ObservationPricingDirectory,
  SaveObservationPrice,
} from '@agent-workflow/shared'
import { RuntimePricing } from '../src/components/observability/RuntimePricing'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const ROOT = '/api/observability/pricing'

function price(id: string, rates: ObservationPrice['rates'], createdAt = 1): ObservationPrice {
  return {
    id,
    runtimeId: 'rt-1',
    model: 'haiku',
    rates,
    effectiveFrom: 0,
    createdAt,
    createdBy: 'u-admin',
    note: '',
  }
}

function fixture(options: { directoryStatus?: number } = {}) {
  const haiku = [price('p-1', { input: '1', cacheRead: null, cacheWrite: null, output: '5' })]
  const writes: { runtime: string; body: SaveObservationPrice }[] = []
  const state = { conflictOnce: false }
  const directory = (): ObservationPricingDirectory => ({
    runtimes: [
      {
        runtimeId: 'rt-1',
        name: 'claude-main',
        protocol: 'claude-code',
        configuredModel: 'sonnet',
        models: [
          { model: 'haiku', calls: 3, current: haiku.at(-1) ?? null },
          { model: 'sonnet', calls: 0, current: null },
        ],
      },
    ],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === ROOT)
      return options.directoryStatus
        ? json({ ok: false, code: 'forbidden', message: 'forbidden' }, options.directoryStatus)
        : json(directory())
    if (url.pathname === ROOT + '/rt-1/history')
      return json({ items: url.searchParams.get('model') === 'haiku' ? [...haiku].reverse() : [] })
    if (url.pathname === ROOT + '/rt-1' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as SaveObservationPrice
      writes.push({ runtime: 'rt-1', body })
      if (state.conflictOnce) {
        state.conflictOnce = false
        // Someone else saved meanwhile.
        haiku.push(price('p-2', { input: '2', cacheRead: '0.2', cacheWrite: null, output: '8' }, 2))
        return json({ ok: false, code: 'price-conflict', message: 'changed' }, 409)
      }
      const latest = haiku.at(-1)?.id ?? null
      if (body.model === 'haiku' && body.expectedLatestId !== latest)
        return json({ ok: false, code: 'price-conflict', message: 'changed' }, 409)
      const saved = { ...price(`p-${haiku.length + 1}`, body.rates, 3), model: body.model }
      if (body.model === 'haiku') haiku.push(saved)
      return json(saved, 201)
    }
    throw new Error('Unexpected request: ' + url.pathname)
  })
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: RuntimePricing,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  )
  return { writes, state }
}

function row(model: string) {
  const table = screen.getByRole('table', { name: 'claude-main 的模型' })
  return within(table).getByRole('row', { name: new RegExp('^' + model) })
}

beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('test-token')
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setToken('')
})

test('each runtime lists its configured and reported models with their current price', async () => {
  fixture()
  await screen.findByRole('table', { name: 'claude-main 的模型' })
  expect(within(row('sonnet')).getByText('配置模型')).toBeDefined()
  expect(within(row('sonnet')).getByText('未定价')).toBeDefined()
  expect(within(row('haiku')).getByText(/输入 ¥1 · 缓存读取 未定价/)).toBeDefined()
  expect(
    within(row('sonnet')).getByRole('button', { name: '价格历史' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('invalid rates never reach the server; a valid save closes the editor', async () => {
  const f = fixture()
  await screen.findByRole('table', { name: 'claude-main 的模型' })
  const trigger = within(row('sonnet')).getByRole('button', { name: '配置价格' })
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  expect(
    (within(dialog).getByLabelText('模型（运行时报告的名称）') as HTMLInputElement).disabled,
  ).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('输入'), { target: { value: '-1' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存价格' }))
  expect(await within(dialog).findByText('请输入不超过 6 位小数的非负金额')).toBeDefined()
  expect(f.writes).toHaveLength(0)

  fireEvent.change(within(dialog).getByLabelText('输入'), { target: { value: '3' } })
  fireEvent.change(within(dialog).getByLabelText('输出（含推理）'), { target: { value: '15' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存价格' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.writes[0]?.body).toMatchObject({
    model: 'sonnet',
    rates: { input: '3', cacheRead: null, cacheWrite: null, output: '15' },
    note: '',
    expectedLatestId: null,
  })
  expect(typeof f.writes[0]?.body.effectiveFrom).toBe('number')
})

test('a conflict keeps the draft and the save can continue from the latest version', async () => {
  const f = fixture()
  f.state.conflictOnce = true
  await screen.findByRole('table', { name: 'claude-main 的模型' })
  fireEvent.click(within(row('haiku')).getByRole('button', { name: '配置价格' }))
  const dialog = await screen.findByRole('dialog')
  expect((within(dialog).getByLabelText('输入') as HTMLInputElement).value).toBe('1')
  fireEvent.change(within(dialog).getByLabelText('输入'), { target: { value: '1.5' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存价格' }))
  expect(await within(dialog).findByText(/你的草稿已保留/)).toBeDefined()
  expect(f.writes[0]?.body.expectedLatestId).toBe('p-1')
  expect((within(dialog).getByLabelText('输入') as HTMLInputElement).value).toBe('1.5')

  fireEvent.click(within(dialog).getByRole('button', { name: '查看最新价格' }))
  expect(await within(dialog).findByText(/最新价格：输入 ¥2 · 缓存读取 ¥0.2/)).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: '基于最新价格继续编辑' }))
  expect((within(dialog).getByLabelText('输入') as HTMLInputElement).value).toBe('1.5')
  fireEvent.click(within(dialog).getByRole('button', { name: '保存价格' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.writes[1]?.body).toMatchObject({ expectedLatestId: 'p-2', rates: { input: '1.5' } })
})

test('a new model needs a name; history shows unknown rates as unpriced', async () => {
  const f = fixture()
  await screen.findByRole('table', { name: 'claude-main 的模型' })
  fireEvent.click(screen.getByRole('button', { name: '为其他模型定价' }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '保存价格' }))
  expect(await within(dialog).findByText('请填写模型名称')).toBeDefined()
  expect(f.writes).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  fireEvent.click(within(row('haiku')).getByRole('button', { name: '价格历史' }))
  dialog = await screen.findByRole('dialog')
  const history = await within(dialog).findByRole('table')
  expect(within(history).getByText('¥1')).toBeDefined()
  expect(within(history).getAllByText('未定价')).toHaveLength(2)
})

test('without settings write permission the section stays quiet', async () => {
  fixture({ directoryStatus: 403 })
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByTestId('loading-state')).toBeNull())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('没有已注册的运行时')).toBeNull()
})
