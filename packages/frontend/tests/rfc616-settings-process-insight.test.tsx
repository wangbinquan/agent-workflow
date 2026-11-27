// RFC-616 §9.4 (design/RFC-616-process-metrics/design.md) — the two settings of
// process metrics' text theme analysis, on the System agents section:
//   · `processInsightRuntime`  — the runtime the analysis runs on; unset means
//     the default runtime.
//   · `processInsightSchedule` — `manual` or `weekly`; unset means manual.
//
// Three ways this goes wrong without any error on screen, each locked below:
//   1. A key missing from the section's minimal-write allowlist. The form looks
//      edited, Save reports success, and the value is silently dropped (the
//      RFC-311 incident recorded in settings-scope-coverage.test.ts).
//   2. "Inherit" encoded as undefined. JSON.stringify drops it, the server reads
//      "no change", and a saved runtime can never be cleared again (RFC-117).
//      The choice has to reach the request body as null.
//   3. Copy in one language only: i18next then renders the key itself.
//
// The render cases follow settings-system-agents-render.test.tsx: the exported
// SystemAgentsTab under a real QueryClient, with fetch mocked at the network
// boundary so the assertions read the actual PUT /api/config body.

import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ConfigPatchSchema,
  DEFAULT_CONFIG,
  PROCESS_INSIGHT_SCHEDULES,
  type Config,
  type ConfigPatch,
} from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'
import {
  SETTINGS_CONFIG_SCOPE_IDS,
  SETTINGS_CONFIG_SCOPE_KEYS,
  createSettingsDraftRegistry,
  getSettingsDraftScope,
  selectSettingsConfigPatch,
  settingsDraftRegistryReducer,
  type SettingsDraftRegistryState,
} from '../src/lib/settings-drafts'
import { SystemAgentsTab } from '../src/routes/settings'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

const scope = SETTINGS_CONFIG_SCOPE_IDS.systemAgents
const KEYS = ['processInsightRuntime', 'processInsightSchedule'] as const

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, language: 'zh-CN', theme: 'system', ...overrides }
}

/** What the page does on a field change: the whole section draft with one field replaced. */
function edit(
  registry: SettingsDraftRegistryState,
  patch: ConfigPatch,
): SettingsDraftRegistryState {
  return settingsDraftRegistryReducer(registry, {
    type: 'edit',
    scope,
    draft: { ...getSettingsDraftScope(registry, scope).draft, ...patch },
  })
}

/** A Save that the server answers with `persisted`. */
function save(
  registry: SettingsDraftRegistryState,
  persisted: Config,
  requestId: string,
): SettingsDraftRegistryState {
  const valid = settingsDraftRegistryReducer(registry, {
    type: 'validity',
    scope,
    validity: 'valid',
  })
  const submittedRevision = getSettingsDraftScope(valid, scope).revision
  const submitting = settingsDraftRegistryReducer(valid, {
    type: 'begin-submit',
    scope,
    requestId,
    submittedRevision,
  })
  return settingsDraftRegistryReducer(submitting, {
    type: 'submit-success',
    scope,
    requestId,
    submittedRevision,
    receipt: { generation: 1, writeEpoch: 1, ignoreReadsThroughEpoch: 1, config: persisted },
  })
}

describe('RFC-616 process insight settings — draft ownership', () => {
  test('both keys belong to the System agents section, and to no other', () => {
    for (const key of KEYS) {
      expect(SETTINGS_CONFIG_SCOPE_KEYS.systemAgents as readonly string[]).toContain(key)
      const owners = Object.entries(SETTINGS_CONFIG_SCOPE_KEYS)
        .filter(([, keys]) => (keys as readonly string[]).includes(key))
        .map(([section]) => section)
      expect(owners, key).toEqual(['systemAgents'])
    }
  })

  test('a fresh configuration has neither value; a stored one loads into the draft', () => {
    const fresh = getSettingsDraftScope(createSettingsDraftRegistry(config()), scope)
    expect(fresh.draft.processInsightRuntime).toBeUndefined()
    expect(fresh.draft.processInsightSchedule).toBeUndefined()

    const stored = getSettingsDraftScope(
      createSettingsDraftRegistry(
        config({ processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' }),
      ),
      scope,
    )
    expect(stored).toMatchObject({
      baseline: { processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' },
      draft: { processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' },
      dirty: false,
    })
  })

  test('a later configuration read replaces a clean draft with the stored values', () => {
    let registry = createSettingsDraftRegistry(config(), { generation: 1, issuedEpoch: 1 })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-read',
      receipt: {
        type: 'read',
        generation: 1,
        issuedEpoch: 2,
        config: config({ processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' }),
      },
    })
    expect(getSettingsDraftScope(registry, scope)).toMatchObject({
      baseline: { processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' },
      draft: { processInsightRuntime: 'fast-oc', processInsightSchedule: 'weekly' },
      dirty: false,
    })
  })
})

describe('RFC-616 process insight settings — what a Save sends', () => {
  test('choosing a runtime sends its name, and nothing else', () => {
    const registry = edit(createSettingsDraftRegistry(config()), {
      processInsightRuntime: 'fast-oc',
    })
    expect(selectSettingsConfigPatch(registry, scope)).toEqual({
      processInsightRuntime: 'fast-oc',
    })
  })

  test('"inherit" on a saved runtime sends null, which survives JSON and the patch schema', () => {
    const registry = edit(
      createSettingsDraftRegistry(config({ processInsightRuntime: 'fast-oc' })),
      { processInsightRuntime: null },
    )
    const patch = selectSettingsConfigPatch(registry, scope)
    expect(patch).toEqual({ processInsightRuntime: null })
    // undefined would vanish here and the server would read "no change".
    expect(JSON.parse(JSON.stringify(patch))).toEqual({ processInsightRuntime: null })
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true)
  })

  test('the schedule round-trips: weekly is saved, then manual is saved over it', () => {
    let registry = createSettingsDraftRegistry(config())

    registry = edit(registry, { processInsightSchedule: 'weekly' })
    expect(selectSettingsConfigPatch(registry, scope)).toEqual({
      processInsightSchedule: 'weekly',
    })
    registry = save(registry, config({ processInsightSchedule: 'weekly' }), 'insight-save-1')
    expect(getSettingsDraftScope(registry, scope)).toMatchObject({
      baseline: { processInsightSchedule: 'weekly' },
      draft: { processInsightSchedule: 'weekly' },
      dirty: false,
    })
    expect(selectSettingsConfigPatch(registry, scope)).toEqual({})

    registry = edit(registry, { processInsightSchedule: 'manual' })
    const patch = selectSettingsConfigPatch(registry, scope)
    expect(patch).toEqual({ processInsightSchedule: 'manual' })
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true)
  })

  test.each(PROCESS_INSIGHT_SCHEDULES)(
    'a stored "%s" schedule is clean on load: opening the page writes nothing',
    (schedule) => {
      const registry = createSettingsDraftRegistry(config({ processInsightSchedule: schedule }))
      expect(getSettingsDraftScope(registry, scope).draft.processInsightSchedule).toBe(schedule)
      expect(selectSettingsConfigPatch(registry, scope)).toEqual({})
    },
  )
})

// --- the page ---------------------------------------------------------------

const MERGER_ID = '00000000000000000000000001'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** PUT /api/config is a merge patch: null removes the key, anything else replaces it. */
function applyConfigPatch(current: Config, patch: Record<string, unknown>): Config {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next as unknown as Config
}

function renderTab(initial: Config): { configPuts: Array<Record<string, unknown>> } {
  const recorded = { configPuts: [] as Array<Record<string, unknown>> }
  let current = initial
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (target.includes('/api/runtimes') && method === 'GET') {
        return json({
          runtimes: [
            { name: 'opencode', protocol: 'opencode', enabled: true },
            { name: 'fast-oc', protocol: 'opencode', enabled: true },
          ],
        })
      }
      if (target.includes('/api/agents/builtins/skill-merger') && method === 'GET') {
        return json({
          id: MERGER_ID,
          name: 'aw-skill-merger',
          runtime: 'opencode',
          builtin: true,
          updatedAt: 100,
          aclRevision: 3,
        })
      }
      if (target.includes('/api/config') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        recorded.configPuts.push(body)
        current = applyConfigPatch(current, body)
        return json(current)
      }
      if (target.includes('/api/config') && method === 'GET') return json(current)
      return json({})
    },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<SystemAgentsTab config={initial} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  return recorded
}

// RuntimeSelect is the shared <Select>: a combobox named after the field and a
// portaled listbox whose options commit on mousedown.
async function pickRuntime(comboName: string, optionText: string): Promise<void> {
  act(() => {
    fireEvent.click(screen.getByRole('combobox', { name: comboName }))
  })
  await waitFor(() => {
    expect(within(screen.getByRole('listbox')).getByText(optionText)).toBeTruthy()
  })
  act(() => {
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText(optionText))
  })
}

function scheduleOption(schedule: (typeof PROCESS_INSIGHT_SCHEDULES)[number]): HTMLElement {
  const group = screen.getByRole('radiogroup', {
    name: i18n.t('settings.processInsightScheduleLabel'),
  })
  const label = {
    manual: i18n.t('settings.processInsightScheduleManual'),
    weekly: i18n.t('settings.processInsightScheduleWeekly'),
  }[schedule]
  return within(group).getByRole('radio', { name: label })
}

function clickSave(): void {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => /保存|Save/.test(candidate.textContent ?? ''))
  expect(button).toBeTruthy()
  act(() => {
    fireEvent.click(button!)
  })
}

describe('RFC-616 process insight settings — System agents section', () => {
  beforeEach(() => {
    // A fresh daemon identity per test: the configuration writer is a per-daemon singleton.
    setBaseUrl(`http://rfc616-process-insight-${crypto.randomUUID()}.test`)
    setToken('tok')
    void i18n.changeLanguage('en-US')
  })

  afterEach(() => {
    cleanup()
    clearToken()
    vi.restoreAllMocks()
  })

  test('the card shows the runtime picker and a two-option schedule; unset reads as manual', () => {
    renderTab(config())

    expect(
      screen
        .getByRole('heading', {
          name: i18n.t('settings.systemAgents.processInsightTitle'),
          level: 3,
        })
        .classList.contains('card__title'),
    ).toBe(true)
    expect(
      screen.getByRole('combobox', { name: i18n.t('settings.processInsightRuntimeLabel') }),
    ).toBeTruthy()
    const group = screen.getByRole('radiogroup', {
      name: i18n.t('settings.processInsightScheduleLabel'),
    })
    expect(within(group).getAllByRole('radio')).toHaveLength(PROCESS_INSIGHT_SCHEDULES.length)
    expect(scheduleOption('manual').getAttribute('aria-checked')).toBe('true')
    expect(scheduleOption('weekly').getAttribute('aria-checked')).toBe('false')
  })

  test('a stored weekly schedule is the selected option', () => {
    renderTab(config({ processInsightSchedule: 'weekly' }))
    expect(scheduleOption('weekly').getAttribute('aria-checked')).toBe('true')
    expect(scheduleOption('manual').getAttribute('aria-checked')).toBe('false')
  })

  test('picking a runtime and saving PUTs only processInsightRuntime', async () => {
    const recorded = renderTab(config())

    await pickRuntime(i18n.t('settings.processInsightRuntimeLabel'), 'fast-oc')
    clickSave()

    await waitFor(() => expect(recorded.configPuts).toHaveLength(1))
    expect(recorded.configPuts[0]).toEqual({ processInsightRuntime: 'fast-oc' })
  })

  test('picking "inherit" over a saved runtime PUTs processInsightRuntime: null', async () => {
    const recorded = renderTab(config({ processInsightRuntime: 'fast-oc' }))

    await pickRuntime(
      i18n.t('settings.processInsightRuntimeLabel'),
      i18n.t('settings.runtimeInherit'),
    )
    clickSave()

    await waitFor(() => expect(recorded.configPuts).toHaveLength(1))
    // null, not a missing key: the body went through JSON.stringify on the way here.
    expect(recorded.configPuts[0]).toEqual({ processInsightRuntime: null })
  })

  test('switching to weekly and saving PUTs only processInsightSchedule: weekly', async () => {
    const recorded = renderTab(config())

    act(() => {
      fireEvent.click(scheduleOption('weekly'))
    })
    expect(scheduleOption('weekly').getAttribute('aria-checked')).toBe('true')
    clickSave()

    await waitFor(() => expect(recorded.configPuts).toHaveLength(1))
    expect(recorded.configPuts[0]).toEqual({ processInsightSchedule: 'weekly' })
  })

  test('switching a saved weekly schedule back to manual PUTs manual', async () => {
    const recorded = renderTab(config({ processInsightSchedule: 'weekly' }))

    act(() => {
      fireEvent.click(scheduleOption('manual'))
    })
    expect(scheduleOption('manual').getAttribute('aria-checked')).toBe('true')
    clickSave()

    await waitFor(() => expect(recorded.configPuts).toHaveLength(1))
    expect(recorded.configPuts[0]).toEqual({ processInsightSchedule: 'manual' })
  })
})

describe('RFC-616 process insight settings — source wiring', () => {
  const settings = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
    'utf8',
  )
  const start = settings.indexOf('export function SystemAgentsTab')
  const tab = settings.slice(start, settings.indexOf('function RenderingTab', start))

  test('the slice is the System agents tab (an empty slice would pass everything below)', () => {
    expect(start).toBeGreaterThan(0)
    expect(tab.length).toBeGreaterThan(2_000)
    expect(tab).toContain("title={t('settings.systemAgents.processInsightTitle')}")
  })

  test('the runtime picker hands its value to the draft unchanged, like changeNarrativeRuntime', () => {
    expect(tab).toContain('value={state.processInsightRuntime}')
    // RuntimeSelect already turns "inherit" into null; anything done to `v` here
    // (a `?? undefined`, a `|| ''`) would lose it again.
    expect(tab).toContain('onChange={(v) => setState({ ...state, processInsightRuntime: v })}')
    expect(tab).toContain('onChange={(v) => setState({ ...state, changeNarrativeRuntime: v })}')
  })

  test('the schedule is the shared Segmented control, reading unset as manual', () => {
    expect(tab).toContain("<Segmented<NonNullable<Config['processInsightSchedule']>>")
    expect(tab).toContain("value={state.processInsightSchedule ?? 'manual'}")
    expect(tab).toContain('onChange={(v) => setState({ ...state, processInsightSchedule: v })}')
    expect(tab).not.toContain('<select')
  })
})

describe('RFC-616 process insight settings — copy in both languages', () => {
  const FIELD_KEYS = [
    'processInsightRuntimeLabel',
    'processInsightRuntimeHint',
    'processInsightScheduleLabel',
    'processInsightScheduleHint',
    'processInsightScheduleManual',
    'processInsightScheduleWeekly',
  ] as const
  const CARD_KEYS = ['processInsightTitle', 'processInsightHint'] as const

  test('every label, hint and option exists in zh-CN and en-US, each in its own words', () => {
    for (const key of FIELD_KEYS) {
      expect(zhCN.settings[key].length, `zh-CN settings.${key}`).toBeGreaterThan(0)
      expect(enUS.settings[key].length, `en-US settings.${key}`).toBeGreaterThan(0)
      expect(zhCN.settings[key], key).not.toBe(enUS.settings[key])
    }
    for (const key of CARD_KEYS) {
      expect(zhCN.settings.systemAgents[key].length, `zh-CN ${key}`).toBeGreaterThan(0)
      expect(enUS.settings.systemAgents[key].length, `en-US ${key}`).toBeGreaterThan(0)
      expect(zhCN.settings.systemAgents[key], key).not.toBe(enUS.settings.systemAgents[key])
    }
  })

  test('the Chinese labels and options are the ones the RFC settled on', () => {
    expect(zhCN.settings.processInsightRuntimeLabel).toBe('过程主题分析运行时')
    expect(zhCN.settings.processInsightScheduleLabel).toBe('过程主题分析的触发方式')
    expect(zhCN.settings.processInsightScheduleManual).toBe('手动')
    expect(zhCN.settings.processInsightScheduleWeekly).toBe('每周定时')
  })

  test('the schedule hint explains both options and where the usage is counted', () => {
    expect(zhCN.settings.processInsightScheduleHint).toContain('手动')
    expect(zhCN.settings.processInsightScheduleHint).toContain('每周定时')
    expect(zhCN.settings.processInsightScheduleHint).toContain('系统执行')
    expect(enUS.settings.processInsightScheduleHint).toContain('Manual')
    expect(enUS.settings.processInsightScheduleHint).toContain('Weekly')
    // The same words the run observation page uses for that tab.
    expect(zhCN.settings.processInsightScheduleHint).toContain(zhCN.runObservability.tabSystem)
    expect(enUS.settings.processInsightScheduleHint.toLowerCase()).toContain(
      enUS.runObservability.tabSystem.toLowerCase(),
    )
  })
})
