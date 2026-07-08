// RFC-156 — SystemAgentsTab live behavior (the parts a source grep can't prove):
//   1. Merge runtime selector → config PUT carries mergeAgentRuntime AND
//      mergeAgentModel:null (D6 — else "inherit" falls through to a stale legacy
//      model instead of the global default).
//   2. Fusion runtime selector → a RUNTIME-ONLY PUT to /api/agents/aw-skill-merger
//      whose body keys are EXACTLY ['runtime']; any extra key would 403
//      builtin-readonly. Picking "inherit" sends { runtime: null }.
//
// RuntimeSelect is the shared RFC-036 <Select>: a role=combobox trigger carrying
// the field's aria-label + a portaled role=listbox. Options come from
// /api/runtimes (useRuntimesList), so we mock that too.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Config } from '@agent-workflow/shared'
import { SystemAgentsTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    $schema_version: 1,
    maxConcurrentNodes: 4,
    multiProcessSubprocessConcurrency: 4,
    defaultPerTaskMaxDurationMs: 3_600_000,
    defaultPerTaskMaxTotalTokens: 0,
    defaultPerNodeTimeoutMs: 1_800_000,
    worktreeAutoGc: { enabled: false },
    eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
    largeOutputThresholdBytes: 1_048_576,
    bindHost: '127.0.0.1',
    language: 'zh-CN',
    theme: 'system',
    logLevel: 'info',
    ...overrides,
  } as Config
}

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface Recorded {
  configPuts: Array<Record<string, unknown>>
  agentPuts: Array<Record<string, unknown>>
}

function mockFetch(): Recorded {
  const rec: Recorded = { configPuts: [], agentPuts: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      if (s.includes('/api/runtimes') && method === 'GET') {
        return json({
          runtimes: [
            { name: 'opencode', protocol: 'opencode', enabled: true },
            { name: 'fast-oc', protocol: 'opencode', enabled: true },
          ],
        })
      }
      if (s.includes('/api/agents/aw-skill-merger') && method === 'PUT') {
        rec.agentPuts.push(body ?? {})
        return json({ name: 'aw-skill-merger', runtime: body?.runtime ?? null, builtin: true })
      }
      if (s.includes('/api/agents/aw-skill-merger') && method === 'GET') {
        return json({ name: 'aw-skill-merger', runtime: 'opencode', builtin: true })
      }
      if (s.includes('/api/config') && method === 'PUT') {
        rec.configPuts.push(body ?? {})
        return json(mkConfig({ ...(body as Partial<Config>) }))
      }
      return json({})
    },
  )
  return rec
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  void i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

// Open the RuntimeSelect combobox with the given accessible name, wait for the
// runtimes query to populate `optionText`, then commit it (mousedown, not click —
// the option handler runs on mousedown to keep focus).
async function pickRuntime(comboName: string, optionText: string) {
  const combo = screen.getByRole('combobox', { name: comboName })
  act(() => {
    fireEvent.click(combo)
  })
  await waitFor(() => {
    expect(within(screen.getByRole('listbox')).getByText(optionText)).toBeTruthy()
  })
  act(() => {
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText(optionText))
  })
}

function clickSave() {
  const saveBtn = screen.getAllByRole('button').find((b) => /保存|Save/.test(b.textContent ?? ''))
  expect(saveBtn).toBeTruthy()
  act(() => {
    fireEvent.click(saveBtn!)
  })
}

describe('RFC-156 SystemAgentsTab — config edit → config PUT (D6), fusion left alone', () => {
  test('picking a merge runtime + Save PUTs mergeAgentRuntime with mergeAgentModel:null and no agent PATCH', async () => {
    const rec = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })

    await pickRuntime(i18n.t('settingsForm.mergeAgentRuntime'), 'fast-oc')
    clickSave()

    await waitFor(() => expect(rec.configPuts).toHaveLength(1))
    const body = rec.configPuts[0]!
    expect(body.mergeAgentRuntime).toBe('fast-oc')
    // D6: the paired legacy model is cleared in the SAME PUT so "inherit" (and any
    // pick) can't fall through to a stale model. null survives JSON.stringify.
    expect(body.mergeAgentModel).toBeNull()
    // A config-only edit does not drag the fusion agent row along.
    expect(rec.agentPuts).toHaveLength(0)
  })
})

describe('RFC-156 SystemAgentsTab — fusion save is a runtime-only agent patch', () => {
  // GET /api/agents/aw-skill-merger resolves to runtime 'opencode'; wait for the
  // combobox to reflect it so a later "inherit" pick genuinely differs from the
  // loaded value (the Save only PATCHes the agent row when it actually changed).
  async function waitFusionLoaded() {
    await waitFor(() => {
      const combo = screen.getByRole('combobox', {
        name: i18n.t('settings.systemAgents.fusionRuntime'),
      })
      expect(combo.textContent).toContain('opencode')
    })
  }

  test('fusion-only edit PATCHes body === { runtime } and skips the config PUT (P2c)', async () => {
    const rec = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    await waitFusionLoaded()

    await pickRuntime(i18n.t('settings.systemAgents.fusionRuntime'), 'fast-oc')
    clickSave()

    await waitFor(() => expect(rec.agentPuts).toHaveLength(1))
    const body = rec.agentPuts[0]!
    // Runtime-ONLY: exactly one key, or the builtin read-only lock 403s.
    expect(Object.keys(body)).toEqual(['runtime'])
    expect(body.runtime).toBe('fast-oc')
    // P2c: a fusion-only save must NOT re-PUT the config slice (would clobber a
    // concurrent commit/memory/merge edit made after this tab loaded).
    expect(rec.configPuts).toHaveLength(0)
  })

  test('picking "inherit" + Save sends { runtime: null } and skips the config PUT', async () => {
    const rec = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    await waitFusionLoaded()

    await pickRuntime(
      i18n.t('settings.systemAgents.fusionRuntime'),
      i18n.t('settings.runtimeInherit'),
    )
    clickSave()

    await waitFor(() => expect(rec.agentPuts).toHaveLength(1))
    const body = rec.agentPuts[0]!
    expect(Object.keys(body)).toEqual(['runtime'])
    expect(body.runtime).toBeNull()
    expect(rec.configPuts).toHaveLength(0)
  })

  test('a no-op Save (nothing changed) writes neither endpoint', async () => {
    const rec = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    await waitFusionLoaded()

    clickSave() // nothing dirty
    await Promise.resolve()
    await Promise.resolve()
    expect(rec.configPuts).toHaveLength(0)
    expect(rec.agentPuts).toHaveLength(0)
  })

  // Codex impl-gate P2a: an unresolved / failed merger GET makes fusionCurrent fall
  // back to null → the field would show "Inherit". It must be DISABLED (so the
  // not-yet-known value can't be edited or mistaken for inherit); a config-only save
  // still works while the un-loadable fusion row is left untouched.
  test('a failed fusion GET disables the field; config still saves, fusion is not patched', async () => {
    const rec: { configPuts: Array<Record<string, unknown>>; agentPuts: Array<unknown> } = {
      configPuts: [],
      agentPuts: [],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const s = typeof url === 'string' ? url : url.toString()
        const method = init?.method ?? 'GET'
        if (s.includes('/api/runtimes'))
          return json({ runtimes: [{ name: 'fast-oc', protocol: 'opencode', enabled: true }] })
        if (s.includes('/api/agents/aw-skill-merger') && method === 'GET')
          return new Response('{"error":"forbidden"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        if (s.includes('/api/agents/aw-skill-merger') && method === 'PUT') {
          rec.agentPuts.push(init?.body ? JSON.parse(String(init.body)) : {})
          return json({})
        }
        if (s.includes('/api/config') && method === 'PUT') {
          rec.configPuts.push(init?.body ? JSON.parse(String(init.body)) : {})
          return json(mkConfig())
        }
        return json({})
      },
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })

    const fusionCombo = screen.getByRole('combobox', {
      name: i18n.t('settings.systemAgents.fusionRuntime'),
    })
    await waitFor(() => expect((fusionCombo as HTMLButtonElement).disabled).toBe(true))

    // A config edit still saves fine despite the un-loadable fusion row.
    await pickRuntime(i18n.t('settingsForm.mergeAgentRuntime'), 'fast-oc')
    clickSave()
    await waitFor(() => expect(rec.configPuts).toHaveLength(1))
    expect(rec.agentPuts).toHaveLength(0)
  })

  // Codex impl-gate P2b: when BOTH config and fusion changed, the writes are
  // SEQUENCED — a rejected config PUT must not leave the fusion runtime applied.
  test('a rejected config PUT leaves the fusion runtime unpatched (sequenced)', async () => {
    const rec: { configPuts: Array<unknown>; agentPuts: Array<unknown> } = {
      configPuts: [],
      agentPuts: [],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const s = typeof url === 'string' ? url : url.toString()
        const method = init?.method ?? 'GET'
        if (s.includes('/api/runtimes'))
          return json({
            runtimes: [
              { name: 'opencode', protocol: 'opencode', enabled: true },
              { name: 'fast-oc', protocol: 'opencode', enabled: true },
            ],
          })
        if (s.includes('/api/agents/aw-skill-merger') && method === 'GET')
          return json({ name: 'aw-skill-merger', runtime: 'opencode' })
        if (s.includes('/api/agents/aw-skill-merger') && method === 'PUT') {
          rec.agentPuts.push(init?.body ? JSON.parse(String(init.body)) : {})
          return json({})
        }
        if (s.includes('/api/config') && method === 'PUT') {
          rec.configPuts.push(init?.body ? JSON.parse(String(init.body)) : {})
          // Reject the config save (e.g. an out-of-range field).
          return new Response('{"error":"config-invalid"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return json({})
      },
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })

    await waitFor(() => {
      const combo = screen.getByRole('combobox', {
        name: i18n.t('settings.systemAgents.fusionRuntime'),
      })
      expect(combo.textContent).toContain('opencode')
    })
    // Change BOTH a config field and fusion, so the config PUT fires (and rejects)
    // and the fusion PATCH is gated behind its success.
    await pickRuntime(i18n.t('settingsForm.mergeAgentRuntime'), 'fast-oc')
    await pickRuntime(i18n.t('settings.systemAgents.fusionRuntime'), 'fast-oc')
    clickSave()

    await waitFor(() => expect(rec.configPuts).toHaveLength(1))
    // config rejected → its onSuccess never runs → the sequenced fusion PATCH is
    // skipped. Flush microtasks and confirm the row stayed unpatched.
    await Promise.resolve()
    await Promise.resolve()
    expect(rec.agentPuts).toHaveLength(0)
  })
})
