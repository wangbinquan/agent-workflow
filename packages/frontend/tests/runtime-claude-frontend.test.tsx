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
//     picker 只在还有别的可选 runtime 时保留（否则隐藏）。
//
// The ModelSelect runtime-namespace behavior (#1/#2) still matters — RFC-113's
// RuntimeFormDialog reuses <ModelSelect> per protocol — so those tests stay.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { ModelSelect } from '../src/components/ModelSelect'
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

  // ...and on failure surfaces the backend's (already-sanitized) reason, never a
  // fallback to some other binary's list.
  test('a failed model fetch shows the backend reason, not a generic line (P2-4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models')) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'opencode-models-failed',
            message: 'opencode models exited 4: provider config missing',
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        )
      }
      return jsonResponse({})
    })
    wrap(<ModelSelect runtimeName="oc-fork" value={undefined} onChange={() => {}} />)
    expect(await screen.findByText(/provider config missing/i)).toBeTruthy()
  })
})

describe('AgentForm — runtime selector (RFC-111)', () => {
  test('renders a Runtime combobox defaulting to "inherit"', async () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // flag-audit §8: claude availability is derived from /api/runtimes (config
    // gate deleted), so the picker mounts once the registry query resolves.
    const trigger = await screen.findByRole('combobox', { name: /^Runtime$/ })
    expect(trigger.textContent).toMatch(/Inherit/)
  })

  test('selecting "Claude Code" surfaces runtime: claude-code on onChange', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    await screen.findByRole('combobox', { name: /^Runtime$/ })
    // Registry-loaded options label by runtime name (`claude-code`); the static
    // "Claude Code" fallback only shows before /api/runtimes resolves.
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

  test('Runtime selector hidden when no claude runtime AND only one built-in opencode', async () => {
    // flag-audit §8: claude 不可用 = 注册表无 enabled 的 claude-protocol 行；
    // 且只剩单个内建 opencode ⇒ 无从选择 ⇒ picker 隐藏。
    runtimesResponse = { runtimes: [{ name: 'opencode', protocol: 'opencode', enabled: true }] }
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // Selector shows optimistically until the registry resolves, then hides.
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: /^Runtime$/ })).toBeNull()
    })
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
