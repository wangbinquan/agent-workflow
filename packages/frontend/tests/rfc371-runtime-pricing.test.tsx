// RFC-371: independent CNY edits preserve drafts and retry the same accepted request.
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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ObservationPriceVersion,
  ObservationPricingRuntime,
  SaveObservationPrice,
} from '@agent-workflow/shared'
import { RuntimePricing } from '../src/components/observability/RuntimePricing'
import { initialPriceDraft, preparePriceRequest } from '../src/components/observability/priceDraft'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const ROOT = '/api/observability/pricing/runtimes'
const runtime: ObservationPricingRuntime = {
  registrationId: 'runtime-1',
  name: 'runtime',
  configurationRevision: 0,
  protocol: 'opencode',
  model: 'original-model',
  enabled: true,
  pricingRevision: 0,
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
function fixture() {
  const current = { ...runtime },
    versions: ObservationPriceVersion[] = [],
    writes: SaveObservationPrice[] = []
  const receipts = new Map<string, ObservationPriceVersion>(),
    paths: string[] = []
  const state = { loseResponse: false }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    paths.push(url.pathname)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === ROOT) return json({ runtimes: [current] })
    if (url.pathname !== ROOT + '/runtime-1/versions')
      throw new Error('Unexpected runtime/config write: ' + url.pathname)
    if (init?.method !== 'POST')
      return json({ items: [...versions].reverse(), revision: current.pricingRevision })
    const input = JSON.parse(String(init.body)) as SaveObservationPrice
    writes.push(input)
    const receipt = receipts.get(input.requestKey)
    if (receipt) return json(receipt, 201)
    if (input.configurationRevision !== current.configurationRevision)
      return json({ ok: false, code: 'runtime-changed', message: 'runtime changed' }, 409)
    if (input.expectedRevision !== current.pricingRevision)
      return json(
        {
          ok: false,
          code: 'price-conflict',
          message: 'price changed',
          details: { revision: current.pricingRevision },
        },
        409,
      )
    const { expectedRevision, requestKey, ...price } = input
    const version = {
      ...price,
      id: 'version-' + (expectedRevision + 1),
      registrationId: current.registrationId,
      revision: expectedRevision + 1,
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    }
    versions.push(version)
    receipts.set(requestKey, version)
    current.pricingRevision = version.revision
    if (state.loseResponse) {
      state.loseResponse = false
      throw new TypeError('Lost response')
    }
    return json(version, 201)
  })
  const root = createRootRoute({ component: () => <Outlet /> })
  const pricing = createRoute({
    getParentRoute: () => root,
    path: '/pricing',
    component: RuntimePricing,
  })
  const other = createRoute({
    getParentRoute: () => root,
    path: '/agents',
    component: () => <p>Other page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([pricing, other]),
    history: createMemoryHistory({ initialEntries: ['/pricing'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  // The fixture deliberately uses a smaller real route tree than the application.
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  )
  return { current, versions, writes, paths, state, router }
}
async function open() {
  const button = await screen.findByRole('button', { name: '配置 Token 单价' })
  button.focus()
  fireEvent.click(button)
  return button
}
function fill() {
  fireEvent.change(screen.getByLabelText('模型服务 / Provider'), { target: { value: 'provider' } })
  fireEvent.change(screen.getByLabelText('非缓存输入'), { target: { value: '0.1' } })
  fireEvent.change(screen.getByLabelText('缓存读取'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('定价来源 / 说明'), {
    target: { value: 'Manual CNY rate' },
  })
}
test('independent CNY save, invalid rate, close/reopen focus and history', async () => {
  const f = fixture(),
    trigger = await open()
  fill()
  fireEvent.change(screen.getByLabelText('非缓存输入'), { target: { value: '-1' } })
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  expect(await screen.findByText('请填写有效值；单价最多 6 位小数')).toBeDefined()
  expect(f.writes).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('非缓存输入'), { target: { value: '0.1' } })
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement === trigger).toBe(true)
  await open()
  expect((screen.getByLabelText('非缓存输入') as HTMLInputElement).value).toBe('0.1')
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.writes[0]).toMatchObject({
    currency: 'CNY',
    rates: { input: '0.1', cacheRead: '0', cacheWrite: null, output: null },
  })
  fireEvent.click(screen.getByRole('button', { name: '价格历史' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('¥0.1')).toBeDefined()
  expect(dialog.textContent).not.toContain('$')
  expect(f.paths.every((path) => path.startsWith(ROOT))).toBe(true)
})
test('a lost response can retry its original key after activation', async () => {
  const f = fixture()
  f.state.loseResponse = true
  await open()
  fill()
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  await waitFor(() => expect(f.versions).toHaveLength(1))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存价格版本' }).hasAttribute('disabled')).toBe(
      false,
    ),
  )
  const first = f.writes[0]!
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.effectiveFrom) + 60_000)
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  clock.mockRestore()
  expect(f.writes).toHaveLength(2)
  expect(f.writes[1]).toEqual(first)
  expect(f.versions).toHaveLength(1)
})
test('runtime change requires inspection and retains the actual model and rate draft', async () => {
  const f = fixture()
  await open()
  fill()
  f.current.configurationRevision = 1
  f.current.model = 'changed-default'
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  fireEvent.click(await screen.findByRole('button', { name: '核对当前运行时与价格版本' }))
  expect(await screen.findByText(/默认模型 changed-default/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '采用当前版本并保留草稿' }))
  expect((screen.getByLabelText('实际模型') as HTMLInputElement).value).toBe('original-model')
  fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.writes[1]).toMatchObject({
    configurationRevision: 1,
    model: 'original-model',
    rates: { input: '0.1' },
  })
  expect(f.writes[0]?.requestKey).not.toBe(f.writes[1]?.requestKey)
})
test('a hidden draft still blocks navigation until the user decides', async () => {
  const f = fixture()
  await open()
  fill()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await act(async () => {
    void f.router.navigate({ to: '/agents' })
  })
  await screen.findByRole('dialog')
  expect(f.router.state.location.pathname).toBe('/pricing')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await open()
  expect((screen.getByLabelText('非缓存输入') as HTMLInputElement).value).toBe('0.1')
})
test('only an unchanged submitted draft bypasses time validation for receipt replay', () => {
  const now = Date.parse('2026-09-28T00:00:00Z')
  const draft = {
    ...initialPriceDraft(runtime, now),
    provider: 'provider',
    sourceNote: 'Source',
    input: '0',
    output: '0.000001',
  }
  const first = preparePriceRequest(draft, runtime, 0, undefined, now, () => 'request-0001')
  expect(first.receipt?.input.rates).toEqual({
    input: '0',
    output: '0.000001',
    cacheRead: null,
    cacheWrite: null,
  })
  expect(
    preparePriceRequest(draft, runtime, 0, first.receipt, now + 600_000, () => 'new-key-1').receipt,
  ).toBe(first.receipt)
  expect(
    preparePriceRequest(
      { ...draft, input: '1' },
      runtime,
      0,
      first.receipt,
      now + 600_000,
      () => 'new-key-2',
    ).errors.effectiveFrom,
  ).toBeDefined()
})
