import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CompleteObservationAttempt } from '@agent-workflow/shared'
import { CompleteObservationTimeline } from '../src/components/observability/CompleteObservationDetails'
import type { ReadyObservationReport } from '../src/components/observability/completeReportClient'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('fixture')
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setToken('')
})

const original: ReadyObservationReport = {
  state: 'ready',
  header: {
    reportId: 'original',
    projectionVersion: 2,
    generation: 'generation',
    snapshotId: 'snapshot',
    asOf: 3000,
    sourceRevision: 'source',
    actorScope: 'reader',
    authorizationRevision: '0',
    filters: { from: 0, to: 4000, timezone: 'UTC' },
    taskId: 'task-a',
  },
  summary: {
    metrics: { state: 'not-applicable' },
    inventory: {
      tasks: '1',
      attempts: '1',
      invocations: '0',
      numericRecords: '0',
      nativeCaptures: '0',
    },
    statuses: {},
    timing: { p50Ms: '1000', p95Ms: '1000', wallMs: '1000', runningMs: '1000', unknown: '0' },
    rootTask: null,
  },
  counts: { attempts: '1', invocations: '0', 'span-facts': '0', 'span-statuses': '0' },
}
const replacement: ReadyObservationReport = {
  ...original,
  header: { ...original.header, reportId: 'replacement', asOf: 3500 },
}
const attempt: CompleteObservationAttempt & { taskId: string; taskName: string } = {
  id: 'attempt-a',
  nodeId: 'Agent A',
  taskId: 'task-a',
  taskName: 'Task A',
  startedAt: 1000,
  finishedAt: 2000,
  status: 'completed',
  retryIndex: 0,
  iteration: 0,
  wgRound: null,
  reviewIteration: 0,
  metrics: { state: 'not-applicable' },
  durationMs: '1000',
  open: false,
}
const buttonName = () => i18n.t('runObservability.detail') + ' · Agent A'

function fixture() {
  let release: ((response: Response) => void) | undefined
  const delayed = new Promise<Response>((resolve) => {
    release = resolve
  })
  const requests: URL[] = []
  const page = (url: URL, items: readonly unknown[]) =>
    Response.json({
      reportId: url.pathname.split('/').at(-2),
      section: url.searchParams.get('section'),
      parent: url.searchParams.get('parent'),
      items,
      total: String(items.length),
      nextCursor: null,
    })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.searchParams.get('section') !== 'attempts') return page(url, [])
    if (url.pathname.includes('/replacement/')) return (await delayed).clone()
    return page(url, [attempt])
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return {
    client,
    requests,
    release: async (items: readonly unknown[] = [attempt], status = 200) => {
      const url = requests.find((request) => request.pathname.includes('/replacement/'))!
      await act(async () => {
        release!(
          status === 200 ? page(url, items) : Response.json({ error: 'unavailable' }, { status }),
        )
      })
    },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}

async function openOriginal(f: ReturnType<typeof fixture>, parent: string | null = null) {
  const view = render(
    <>
      <button type="button">Other control</button>
      <CompleteObservationTimeline report={original} parent={parent} />
    </>,
    { wrapper: f.wrapper },
  )
  const trigger = await screen.findByRole('button', { name: buttonName() })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('dialog')
  await waitFor(() => expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull())
  return {
    trigger,
    replace: (report = replacement, nextParent = parent, showOther = true) => {
      view.rerender(
        <>
          {showOther && <button type="button">Other control</button>}
          <CompleteObservationTimeline report={report} parent={nextParent} />
        </>,
      )
    },
  }
}

test('same-scope replacement restores the original attempt after its delayed new page arrives', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(opened.trigger.isConnected).toBe(false)
  expect(screen.queryByRole('button', { name: buttonName() })).toBeNull()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release()
  const current = await screen.findByRole('button', { name: buttonName() })
  expect(current).not.toBe(opened.trigger)
  await waitFor(() => expect(document.activeElement).toBe(current))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.requests.filter((url) => url.pathname.includes('/replacement/'))).toHaveLength(1)
})

test('Escape while the new page is pending preserves the original attempt return focus', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(document.body)
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(document.activeElement).toBe(document.body)
  await f.release()
  const current = await screen.findByRole('button', { name: buttonName() })
  await waitFor(() => expect(document.activeElement).toBe(current))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test.each(['task', 'filters', 'parent'] as const)(
  'replacement does not restore focus across a changed %s scope',
  async (changed) => {
    const f = fixture()
    const opened = await openOriginal(f)
    const report = {
      ...replacement,
      header: {
        ...replacement.header,
        ...(changed === 'task' ? { taskId: 'task-b' } : {}),
        ...(changed === 'filters' ? { filters: { ...replacement.header.filters, to: 5000 } } : {}),
      },
    }
    opened.replace(report, changed === 'parent' ? JSON.stringify(['task-tree', 'task-b']) : null)
    await waitFor(() =>
      expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
    )
    await f.release()
    const current = await screen.findByRole('button', { name: buttonName() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(current)
  },
)

test('a page error never restores an old attempt or reopens its old details', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release([], 502)
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: buttonName() })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).not.toBe(opened.trigger)
})

test('a missing attempt does not focus another row', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release([{ ...attempt, id: 'attempt-b', nodeId: 'Agent B' }])
  const other = await screen.findByRole('button', {
    name: i18n.t('runObservability.detail') + ' · Agent B',
  })
  expect(document.activeElement).not.toBe(other)
  expect(screen.queryByRole('button', { name: buttonName() })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('waiting for replacement does not steal focus from a control chosen by the user', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  const other = screen.getByRole('button', { name: 'Other control' })
  other.focus()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release()
  await screen.findByRole('button', { name: buttonName() })
  expect(document.activeElement).toBe(other)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a user move remains cancelled even when the chosen control later unmounts', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  screen.getByRole('button', { name: 'Other control' }).focus()
  opened.replace(replacement, null, false)
  expect(document.activeElement).toBe(document.body)
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release()
  const current = await screen.findByRole('button', { name: buttonName() })
  expect(document.activeElement).not.toBe(current)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a later report cannot inherit the first replacement focus request', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  opened.replace({ ...replacement, header: { ...replacement.header, reportId: 'later' } })
  const current = await screen.findByRole('button', { name: buttonName() })
  expect(document.activeElement).not.toBe(current)
  await f.release()
  expect(document.activeElement).not.toBe(current)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a matching attempt ID from another task is not a focus target', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release([{ ...attempt, taskId: 'task-b' }])
  const current = await screen.findByRole('button', { name: buttonName() })
  expect(document.activeElement).not.toBe(current)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('successful restoration is consumed once and subsequent page reads do not steal focus', async () => {
  const f = fixture()
  const opened = await openOriginal(f)
  opened.replace()
  await waitFor(() =>
    expect(f.requests.some((url) => url.pathname.includes('/replacement/'))).toBe(true),
  )
  await f.release()
  const current = await screen.findByRole('button', { name: buttonName() })
  await waitFor(() => expect(document.activeElement).toBe(current))
  const other = screen.getByRole('button', { name: 'Other control' })
  other.focus()
  await act(async () => {
    await f.client.invalidateQueries({
      queryKey: ['run-observability-complete-page', 'replacement', 'attempts'],
    })
  })
  await screen.findByRole('button', { name: buttonName() })
  expect(document.activeElement).toBe(other)
  expect(f.requests.filter((url) => url.pathname.includes('/replacement/'))).toHaveLength(2)
})
