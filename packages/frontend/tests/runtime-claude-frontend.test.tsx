// RFC-111 PR-B (frontend) — Claude Code as a second agent runtime.
//
// Locks the user-facing wiring of the new runtime so a future refactor that
// re-points the model namespace / runtime selector goes red:
//
//  1. <ModelSelect> default (opencode) hits `/api/runtime/models` with NO
//     `?runtime=` param — byte-identical to the pre-RFC-111 behavior.
//  2. <ModelSelect runtime="claude"> hits `/api/runtime/models?runtime=claude`
//     (separate query namespace → curated static Claude list).
//  3. <AgentForm> renders the Runtime <Select> (public combobox chrome, not a
//     raw <select>) defaulting to "inherit", and selecting "Claude Code"
//     surfaces runtime: 'claude-code' upward.
//  4. RFC-113: the AgentForm renders ONLY that runtime Select for runtime
//     concerns — model / variant / temperature / steps moved onto the runtime, so
//     the agent form no longer carries any generation-param field.
//  5. flag-audit §8：`claudeCodeEnabled` 配置门删除后，claude 可用性 = 注册表里
//     存在 enabled 的 claude-protocol 行；无该行时 claude 选项从 picker 消失，
//     picker 只提供注册表里已启用的 runtime。
//  6. RFC-250 P1 follow-up: the Runtime field is a stable part of the form.
//     A single enabled runtime still supports inherit <-> explicit pin, while
//     initial registry loading/error keeps a visible but inoperable selector;
//     errors surface a retryable shared ErrorBanner.
//  7. RFC-305 guest follow-up: a public agent remains readable without
//     `runtime:read`; the form neither requests nor consumes a cached runtime
//     registry and therefore never turns the expected permission boundary into
//     a runtime-load error.
//
// The ModelSelect runtime-namespace behavior (#1/#2) still matters — RFC-113's
// RuntimeFormDialog reuses <ModelSelect> per protocol — so those tests stay.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { ModelSelect } from '../src/components/ModelSelect'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

let fetchUrls: string[] = []
// Each test may override what `/api/config` returns.
let configResponse: unknown = {}
// Each test may override the registered-runtimes list (drives the picker options
// AND — flag-audit §8 — claude availability). Default mirrors a real daemon: the
// two read-only built-ins, both enabled.
let runtimesResponse: unknown = {
  runtimes: [
    { name: 'opencode', protocol: 'opencode', enabled: true },
    { name: 'claude-code', protocol: 'claude-code', enabled: true },
  ],
}

const MODELS_BODY = {
  binary: 'claude',
  models: [{ id: 'opus', provider: 'anthropic', modelID: 'opus', name: 'Opus' }],
  cached: true,
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
}

function wrap(node: React.ReactNode) {
  return render(<QueryClientProvider client={newClient()}>{node}</QueryClientProvider>)
}

// Public Select = button[role=combobox] + portaled ul[role=listbox]; option rows
// fire onChange via mouseDown (fireEvent.click misses the React handler).
function clickSelectOption(triggerName: RegExp, optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: triggerName }) as HTMLButtonElement
  fireEvent.click(trigger)
  const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement | null
  if (list === null) throw new Error('listbox not opened')
  const opt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(optionLabel),
  )
  if (opt === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(opt)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  fetchUrls = []
  configResponse = {}
  runtimesResponse = {
    runtimes: [
      { name: 'opencode', protocol: 'opencode', enabled: true },
      { name: 'claude-code', protocol: 'claude-code', enabled: true },
    ],
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    fetchUrls.push(url)
    if (url.includes('/api/runtime/models')) return jsonResponse(MODELS_BODY)
    if (url.includes('/api/runtimes')) return jsonResponse(runtimesResponse)
    if (url.includes('/api/config')) return jsonResponse(configResponse)
    return jsonResponse([])
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ModelSelect — runtime namespace (RFC-111)', () => {
  test('default (opencode) hits /api/runtime/models with no ?runtime param', async () => {
    wrap(<ModelSelect value={undefined} onChange={() => {}} />)
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models'))).toBe(true)
    })
    const modelUrls = fetchUrls.filter((u) => u.includes('/api/runtime/models'))
    expect(modelUrls.every((u) => !u.includes('runtime=claude'))).toBe(true)
  })

  test('runtime="claude" hits /api/runtime/models?runtime=claude', async () => {
    wrap(<ModelSelect runtime="claude" value={undefined} onChange={() => {}} />)
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models?runtime=claude'))).toBe(true)
    })
  })

  // RFC-114 D6/P2-4: runtimeName fetches that runtime's binary list...
  test('runtimeName=<name> hits /api/runtime/models?runtime=<name>', async () => {
    wrap(<ModelSelect runtimeName="oc-fork" value={undefined} onChange={() => {}} />)
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models?runtime=oc-fork'))).toBe(true)
    })
  })

  // ...and on failure stays on that runtime while routing wire text through the
  // shared localized ErrorBanner.
  test('a failed model fetch shows localized runtime copy and hides the backend reason', async () => {
    await i18n.changeLanguage('en-US')
    const raw = 'opencode models exited 4: provider config missing'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models')) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'opencode-models-failed',
            message: raw,
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        )
      }
      return jsonResponse({})
    })
    wrap(<ModelSelect runtimeName="oc-fork" value={undefined} onChange={() => {}} />)
    expect(await screen.findByText('Failed to fetch the model list.')).toBeTruthy()
    expect(
      screen.getByText(
        'Check that the runtime works and the network / proxy is reachable, then retry.',
      ),
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain(raw)
  })
})

describe('AgentForm — runtime selector (RFC-111 / RFC-250)', () => {
  test('renders a Runtime combobox defaulting to "inherit"', async () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // RFC-250: the picker mounts immediately and stays visible while the
    // registry query resolves; its selected value still defaults to inherit.
    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    expect(trigger.textContent).toMatch(/Inherit/)
  })

  test('selecting "Claude Code" surfaces runtime: claude-code on onChange', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    // Registry-loaded options label by runtime name (`claude-code`).
    clickSelectOption(/^Runtime$/, 'claude-code')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.runtime).toBe('claude-code')
  })

  // RFC-113: model / variant / temperature / steps moved to the RUNTIME. The
  // AgentForm must render NO generation-param field (they'd let an agent override
  // its runtime's params, which RFC-113 forbids) and must NOT fetch the model
  // list (no ModelSelect in the form). A regression that re-adds any of them — or
  // a model dropdown — turns this red.
  test('renders no model/variant/temperature/steps fields and does not fetch models', async () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', runtime: 'claude-code' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // the runtime Select is the only runtime-concern control:
    expect(screen.getByRole('combobox', { name: /^Runtime$/ })).toBeTruthy()
    // none of the removed generation-param field labels render:
    for (const label of ['Model', 'Variant', 'Temperature', 'Steps', 'Max steps']) {
      expect(screen.queryByText(label, { selector: '.form-field__label' })).toBeNull()
    }
    // flag-audit §8: the form drives its runtime concerns off /api/runtimes only
    // (config gate deleted) and never reaches for /api/runtime/models (ModelSelect).
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('/api/runtimes'))).toBe(true))
    expect(fetchUrls.some((u) => u.includes('/api/runtime/models'))).toBe(false)
  })

  test('a single enabled runtime stays visible and can be explicitly pinned', async () => {
    // RFC-250 P1: even when inherit and pin currently resolve to the same
    // runtime, they are different persisted states. Hiding the field made that
    // distinction impossible to inspect or change.
    runtimesResponse = {
      runtimes: [
        {
          name: 'opencode',
          protocol: 'opencode',
          enabled: true,
          isDefault: true,
          model: 'openai/gpt-5',
        },
      ],
    }
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    clickSelectOption(/^Runtime$/, 'opencode')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0].runtime).toBe('opencode')
  })

  test('a single pinned runtime can be changed back to inherit', async () => {
    runtimesResponse = {
      runtimes: [
        {
          name: 'opencode',
          protocol: 'opencode',
          enabled: true,
          isDefault: true,
          model: 'openai/gpt-5',
        },
      ],
    }
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', runtime: 'opencode' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    clickSelectOption(/^Runtime$/, 'Inherit')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0].runtime).toBeUndefined()
  })

  test('an already-pinned disabled runtime remains visible and can be unpinned', async () => {
    runtimesResponse = {
      runtimes: [
        {
          name: 'opencode',
          protocol: 'opencode',
          enabled: true,
          isDefault: true,
          model: 'openai/gpt-5',
        },
        {
          name: 'oc-old',
          protocol: 'opencode',
          enabled: false,
          isDefault: false,
          model: 'openai/gpt-4.1',
        },
      ],
    }
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', runtime: 'oc-old' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    expect(trigger.textContent).toContain('oc-old')
    clickSelectOption(/^Runtime$/, 'Inherit')

    expect(onChange.mock.calls[0]?.[0].runtime).toBeUndefined()
  })

  test('initial runtime-registry loading keeps an explicit disabled Runtime field', async () => {
    await i18n.changeLanguage('en-US')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      fetchUrls.push(url)
      if (url.includes('/api/runtimes')) return await new Promise<Response>(() => {})
      return jsonResponse([])
    })
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    const trigger = screen.getByRole('combobox', { name: /^Runtime$/ }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(screen.getByText('Loading runtimes…')).toBeTruthy()
    expect(screen.queryByTestId('agent-runtime-load-error')).toBeNull()
  })

  test('runtime-registry error keeps the field visible and retry restores its choices', async () => {
    await i18n.changeLanguage('en-US')
    let runtimeAttempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      fetchUrls.push(url)
      if (!url.includes('/api/runtimes')) return jsonResponse([])
      runtimeAttempts += 1
      if (runtimeAttempts === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'runtime-registry-unavailable',
            message: 'private daemon detail',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      return jsonResponse({
        runtimes: [
          {
            name: 'opencode',
            protocol: 'opencode',
            enabled: true,
            isDefault: true,
            model: 'openai/gpt-5',
          },
        ],
      })
    })
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    const error = await screen.findByTestId('agent-runtime-load-error')
    expect(error.textContent).toContain('Could not load the runtime list.')
    const trigger = screen.getByRole('combobox', { name: /^Runtime$/ }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(runtimeAttempts).toBe(2))
    await waitFor(() => expect(trigger.disabled).toBe(false))
    expect(screen.queryByTestId('agent-runtime-load-error')).toBeNull()
  })

  test('unreadable registry stays request-free and ignores a cached privileged snapshot', () => {
    const client = newClient()
    client.setQueryData(['runtimes'], {
      runtimes: [
        {
          name: 'private-runtime',
          protocol: 'opencode',
          enabled: true,
          isDefault: true,
          model: 'private/model',
        },
      ],
    })
    const initial: CreateAgent = {
      ...emptyAgent(),
      name: 'public-agent',
      runtime: 'saved-runtime-name',
    }
    render(
      <QueryClientProvider client={client}>
        <AgentForm value={initial} onChange={() => {}} runtimeRegistryReadable={false} />
      </QueryClientProvider>,
    )

    const trigger = screen.getByRole('combobox', { name: /^Runtime$/ }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('saved-runtime-name')
    expect(trigger.textContent).not.toContain('private-runtime')
    expect(screen.queryByTestId('agent-runtime-load-error')).toBeNull()
    expect(fetchUrls.filter((url) => url.includes('/api/runtimes'))).toEqual([])
  })

  // With no claude runtime, the selector is the ONLY way to assign a custom
  // opencode profile (opencode-opus / opencode-haiku), so it must STAY visible
  // when such runtimes exist — the claude-protocol option simply isn't offered.
  test('no claude runtime + custom opencode runtimes → selector shows, no claude option', async () => {
    runtimesResponse = {
      runtimes: [
        { name: 'opencode', protocol: 'opencode', enabled: true },
        // claude built-in present but DISABLED → not offered, not counted as available.
        { name: 'claude-code', protocol: 'claude-code', enabled: false },
        { name: 'opencode-opus', protocol: 'opencode', enabled: true },
      ],
    }
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // The picker stays visible (custom opencode profile to choose). Open it and
    // wait for the registry to load into the options (the open listbox re-renders
    // when the /api/runtimes query resolves).
    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    // the custom opencode profile appears once the query resolves...
    const opt = await screen.findByRole('option', { name: 'opencode-opus' })
    // ...and the claude-protocol runtime is filtered out (claude disabled).
    expect(screen.queryByRole('option', { name: 'claude-code' })).toBeNull()
    // select it → closes the portaled listbox so afterEach teardown doesn't clash
    // with the open Select portal (happy-dom + React 19 removeChild).
    fireEvent.mouseDown(opt)
  })
})
