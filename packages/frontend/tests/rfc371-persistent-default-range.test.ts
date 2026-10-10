// RFC-371: cold app entry must reopen the qualified report's exact default range.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationReportContent,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'

vi.mock('../src/components/observability/CompleteRunObservability', () => ({
  CompleteRunObservability: () => null,
}))

const NOW = Date.parse('2026-10-10T00:00:00Z')
const PREFIX = 'agent-workflow.observation-default-range/13:'
const TOKEN = 'persistent-range-fixture-account'
const BASE = 'http://localhost:7456'
const REPORT = 'persistent-range-original-report'
let filters: ObservationOverviewQuery

async function coldModules() {
  vi.resetModules()
  const auth = await import('../src/stores/auth')
  const range = await import('../src/components/observability/observationDefaultRange')
  const bookmark = await import('../src/components/observability/completeReportBookmark')
  const route = await import('../src/routes/observability')
  return { auth, range, bookmark, route }
}
type Modules = Awaited<ReturnType<typeof coldModules>>

function content(reportId: string): CompleteObservationReportContent {
  return {
    header: {
      reportId,
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot-' + reportId,
      asOf: NOW,
      sourceRevision: 'original-source-revision',
      actorScope: 'original-reader',
      authorizationRevision: 'original-access',
      filters,
      taskId: null,
    },
    summary: {
      metrics: {
        state: 'ready',
        invocations: '1',
        observedInvocations: '1',
        records: '1',
        tokens: { input: '12', cacheRead: '34', cacheWrite: '0', output: '56', total: '102' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.102' },
      },
      inventory: {
        tasks: '1',
        attempts: '1',
        invocations: '1',
        numericRecords: '1',
        nativeCaptures: '0',
      },
      statuses: { done: '1' },
      timing: { wallMs: '1000', runningMs: '1000', p50Ms: '1000', p95Ms: '1000', unknown: '0' },
      rootTask: null,
    },
    counts: { tasks: '1', trends: '1' },
  }
}

async function qualify(modules: Modules, reportId = REPORT) {
  const bookmark = await modules.bookmark.observationReportBookmark(filters, undefined)
  bookmark.remember(reportId)
  modules.range.rememberObservationDefaultRange(content(reportId), bookmark.current)
  return bookmark
}

function pointers(): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PREFIX)) entries.push([key, localStorage.getItem(key)!])
  }
  return entries
}

beforeEach(async () => {
  localStorage.clear()
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 3600000)
  filters = {
    from: NOW - 7 * 86400000,
    to: NOW,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
  const modules = await coldModules()
  modules.auth.setToken(TOKEN)
  modules.auth.setBaseUrl(BASE)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('module cold entry restores the exact range and original bookmark, storing only four pointer fields', async () => {
  const modules = await coldModules()
  await qualify(modules)
  const saved = pointers()
  expect(saved).toHaveLength(1)
  expect(JSON.parse(saved[0]![1])).toEqual({ reportId: REPORT, ...filters })
  const reopened = await coldModules()
  const search = reopened.route.validateObservationSearch({})
  expect(search).toEqual({ from: filters.from, to: filters.to, period: 'week', tab: 'overview' })
  expect(reopened.route.validateObservationSearch({ tab: 'usage' })).toEqual({
    ...search,
    tab: 'usage',
  })
  const bookmark = await reopened.bookmark.observationReportBookmark(
    { from: search.from, to: search.to, timezone: filters.timezone },
    undefined,
  )
  expect(bookmark.read()).toBe(REPORT)
  expect(bookmark.current()).toBe(true)
  expect(pointers()).toEqual(saved)
})

test.each(['account', 'service'] as const)(
  'a different %s on cold entry cannot choose the original range',
  async (kind) => {
    const modules = await coldModules()
    await qualify(modules)
    if (kind === 'account') modules.auth.setToken(TOKEN + '-other')
    else modules.auth.setBaseUrl(BASE + '/other')
    const reopened = await coldModules()
    expect(reopened.range.observationDefaultRange()).toBeNull()
    expect(reopened.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
  },
)

test.each(['account', 'service'] as const)(
  'switching %s away and back retires the old range before memory is cleared',
  async (kind) => {
    const modules = await coldModules()
    await qualify(modules)
    if (kind === 'account') modules.auth.setToken(TOKEN + '-other')
    else modules.auth.setBaseUrl(BASE + '/other')
    expect(modules.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
    if (kind === 'account') modules.auth.setToken(TOKEN)
    else modules.auth.setBaseUrl(BASE)
    expect(modules.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
    expect(pointers()).toEqual([])
    const reopened = await coldModules()
    expect(reopened.range.observationDefaultRange()).toBeNull()
  },
)

test('a timezone change retires its old pointer and returning to the timezone cannot restore it', async () => {
  const modules = await coldModules()
  await qualify(modules)
  const original = Intl.DateTimeFormat().resolvedOptions()
  let timezone = filters.timezone === 'UTC' ? 'America/New_York' : 'UTC'
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => ({
    ...original,
    timeZone: timezone,
  }))
  expect(modules.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
  timezone = filters.timezone
  expect(modules.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
  expect(pointers()).toEqual([])
  const reopened = await coldModules()
  expect(reopened.range.observationDefaultRange()).toBeNull()
})

test('late retirement of report A preserves report B and its exact pointer through cold entry', async () => {
  const modules = await coldModules()
  await qualify(modules)
  await qualify(modules, 'subsequent-original-report')
  localStorage.setItem(PREFIX + 'malformed-unrelated', '{')
  localStorage.setItem('unrelated-pointer', 'keep')
  modules.bookmark.discardObservationReportBookmark(REPORT)
  const reopened = await coldModules()
  expect(reopened.range.observationDefaultRange()).toEqual({ from: filters.from, to: filters.to })
  const bookmark = await reopened.bookmark.observationReportBookmark(filters, undefined)
  expect(bookmark.read()).toBe('subsequent-original-report')
  expect(
    JSON.parse(pointers().find(([key]) => key !== PREFIX + 'malformed-unrelated')![1]),
  ).toEqual({
    reportId: 'subsequent-original-report',
    ...filters,
  })
  reopened.bookmark.discardObservationReportBookmark('subsequent-original-report')
  expect(reopened.range.observationDefaultRange()).toBeNull()
  expect(localStorage.getItem(PREFIX + 'malformed-unrelated')).toBe('{')
  expect(localStorage.getItem('unrelated-pointer')).toBe('keep')
  const again = await coldModules()
  expect(again.range.observationDefaultRange()).toBeNull()
})

test.each([
  ['bad JSON', (): string => '{'],
  ['null', (): string => 'null'],
  ['array', (): string => '[]'],
  ['missing report ID', () => JSON.stringify(filters)],
  ['empty report ID', () => JSON.stringify({ reportId: '', ...filters })],
  ['numeric report ID', () => JSON.stringify({ reportId: 1, ...filters })],
  [
    'string from',
    () => JSON.stringify({ reportId: REPORT, ...filters, from: String(filters.from) }),
  ],
  ['negative from', () => JSON.stringify({ reportId: REPORT, ...filters, from: -1 })],
  [
    'fractional from',
    () => JSON.stringify({ reportId: REPORT, ...filters, from: filters.from + 0.5 }),
  ],
  [
    'unsafe to',
    () => JSON.stringify({ reportId: REPORT, ...filters, to: Number.MAX_SAFE_INTEGER + 1 }),
  ],
  ['wrong duration', () => JSON.stringify({ reportId: REPORT, ...filters, to: filters.to + 1 })],
  [
    'wrong timezone',
    () => JSON.stringify({ reportId: REPORT, ...filters, timezone: 'invalid-zone' }),
  ],
  ['non-string timezone', () => JSON.stringify({ reportId: REPORT, ...filters, timezone: 42 })],
  ['extra facts', () => JSON.stringify({ reportId: REPORT, ...filters, tokens: '999' })],
] as const)('a %s pointer uses the original route defaults', async (_name, raw) => {
  const modules = await coldModules()
  await qualify(modules)
  localStorage.setItem(pointers()[0]![0], raw())
  const reopened = await coldModules()
  expect(reopened.range.observationDefaultRange()).toBeNull()
  expect(reopened.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
})

test('a pointer read failure uses the original range without changing authentication storage', async () => {
  const modules = await coldModules()
  await qualify(modules)
  const original = Storage.prototype.getItem
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
    if (key.startsWith(PREFIX)) throw new Error('Original storage unavailable')
    return original.call(localStorage, key)
  })
  const reopened = await coldModules()
  expect(reopened.auth.getToken()).toBe(TOKEN)
  expect(reopened.range.observationDefaultRange()).toBeNull()
  expect(reopened.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
})

test('a pointer write failure preserves qualified memory and a cold entry uses the original fallback', async () => {
  const modules = await coldModules()
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
    if (key.startsWith(PREFIX)) throw new Error('Original storage unavailable')
    original.call(localStorage, key, value)
  })
  await qualify(modules)
  expect(modules.range.observationDefaultRange()).toEqual({ from: filters.from, to: filters.to })
  const reopened = await coldModules()
  expect(reopened.range.observationDefaultRange()).toBeNull()
  expect(reopened.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
})

test('failed storage removal cannot resurrect a retired range in the same application', async () => {
  const modules = await coldModules()
  await qualify(modules)
  const original = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
    if (key.startsWith(PREFIX)) throw new Error('Original storage unavailable')
    original.call(localStorage, key)
  })
  modules.auth.setToken(TOKEN + '-other')
  expect(modules.range.observationDefaultRange()).toBeNull()
  modules.auth.setToken(TOKEN)
  expect(modules.range.observationDefaultRange()).toBeNull()
  expect(modules.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
})

test('an unavailable encoding primitive on cold entry leaves the original route fallback intact', async () => {
  const modules = await coldModules()
  await qualify(modules)
  const reopened = await coldModules()
  vi.stubGlobal('TextEncoder', undefined)
  expect(reopened.range.observationDefaultRange()).toBeNull()
  expect(reopened.route.validateObservationSearch({}).to).toBe(NOW + 3600001)
})
