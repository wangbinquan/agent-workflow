// RFC-112 PR-D + RFC-113 + RFC-153 (frontend) — the runtime registry list replaces
// the two stacked RFC-111 status cards. Locks: preseeded (opencode / claude-code)
// + custom rows render alike; every row is editable (name/protocol identity locked
// in the dialog) AND deletable (RFC-153 removed the built-in read-only flag +
// badge; the server 409s only on the effective default / a referenced row); the
// config-default row shows the in-table "default" marker + no "Set default"
// button; a conforming smoke result shows its status; "Add runtime" opens the form
// dialog (public Dialog chrome, not a raw modal).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeList } from '../src/components/RuntimeList'
import { setBaseUrl, setToken } from '../src/stores/auth'

// RFC-113: rows carry the execution profile + an isDefault flag (the server sets
// isDefault = name === config.defaultRuntime). opencode is the default here.
const NULL_PROFILE = { model: null, variant: null, temperature: null, steps: null, maxSteps: null }
const RUNTIMES_BODY = {
  runtimes: [
    {
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
      isDefault: true,
      ...NULL_PROFILE,
      enabled: true,
      lastProbe: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      name: 'claude-code',
      protocol: 'claude-code',
      binaryPath: null,
      isDefault: false,
      ...NULL_PROFILE,
      enabled: true,
      lastProbe: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: '/usr/local/bin/my-oc',
      isDefault: false,
      ...NULL_PROFILE,
      enabled: true,
      model: 'anthropic/claude-opus-4-7',
      lastProbe: {
        outcome: 'conforms',
        conforms: true,
        detail: 'ok',
        sawNonce: true,
        sawEnvelope: false,
        exitCode: 0,
      },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

let fetchUrls: string[] = []

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  fetchUrls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    fetchUrls.push(url)
    // note: '/api/runtime/models' (singular) is checked BEFORE '/api/runtimes'.
    if (url.includes('/api/runtime/models')) {
      return jsonResponse({
        binary: 'opencode',
        cached: true,
        models: [{ id: 'anthropic/opus', provider: 'anthropic', modelID: 'opus', name: 'Opus' }],
      })
    }
    if (url.includes('/api/runtimes')) return jsonResponse(RUNTIMES_BODY)
    return jsonResponse({})
  })
})

afterEach(() => {
  // cleanup() unmounts tracked React roots (incl. the Dialog portal) correctly;
  // manually wiping document.body would double-remove the portal node under
  // happy-dom + React 19 (removeChild DOMException).
  cleanup()
  vi.restoreAllMocks()
})

describe('RuntimeList (RFC-112 PR-D)', () => {
  // RFC-118: a disabled runtime stays in the list — dimmed row + "disabled" chip +
  // an Enable button; the effective-default row's toggle is present but disabled.
  test('disabled runtime: dimmed row + disabled chip + Enable; default toggle is disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models'))
        return jsonResponse({ binary: 'x', cached: false, models: [] })
      if (url.includes('/api/runtimes'))
        return jsonResponse({
          runtimes: [
            {
              name: 'opencode',
              protocol: 'opencode',
              binaryPath: null,
              isDefault: true,
              ...NULL_PROFILE,
              enabled: true,
              lastProbe: null,
              createdAt: 0,
              updatedAt: 0,
            },
            {
              name: 'claude-code',
              protocol: 'claude-code',
              binaryPath: null,
              isDefault: false,
              ...NULL_PROFILE,
              enabled: false,
              lastProbe: null,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })
      return jsonResponse({})
    })
    wrap(<RuntimeList />)
    await waitFor(() => expect(document.querySelector('.runtime-list__name')).toBeTruthy())
    const rowOf = (name: string) =>
      Array.from(document.querySelectorAll('.runtime-list__row')).find(
        (el) => el.querySelector('.runtime-list__name')?.textContent === name,
      )
    // claude-code disabled → dimmed row + "disabled" chip + Enable button.
    expect(rowOf('claude-code')?.className).toContain('runtime-list__row--disabled')
    expect(screen.getByText('disabled')).toBeTruthy()
    // RFC-118: the Enable button is the recovery path — it must be genuinely
    // clickable, NOT greyed-disabled (the dim is scoped to the identity/meta columns
    // only; a row-level opacity used to grey the button while it stayed clickable).
    const enableBtn = screen.getByText('Enable') as HTMLButtonElement
    expect(enableBtn.disabled).toBe(false)
    // opencode is the default → its Disable toggle is present but disabled, and the
    // row is NOT dimmed.
    const ocDisable = Array.from(rowOf('opencode')?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Disable',
    )
    expect(ocDisable?.disabled).toBe(true)
    expect(rowOf('opencode')?.className).not.toContain('runtime-list__row--disabled')
  })

  test('renders built-ins + the custom fork as rows', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(document.querySelector('.runtime-list__name')).toBeTruthy())
    // row NAMES (scoped to .runtime-list__name so the protocol chips — which also
    // read "opencode" — don't collide).
    const names = Array.from(document.querySelectorAll('.runtime-list__name')).map(
      (el) => el.textContent,
    )
    expect(names).toEqual(['opencode', 'claude-code', 'my-oc'])
    // the custom row surfaces its conforming smoke status + its binary path.
    expect(screen.getByText('conforms')).toBeTruthy()
    expect(screen.getByText('/usr/local/bin/my-oc')).toBeTruthy()
  })

  // RFC-116: a network-blocked smoke result renders the "endpoint unreachable"
  // label (NOT "auth missing") as a warn/amber chip — signalling the operator to
  // fix the daemon's network/proxy, not the credentials.
  test('a network-blocked smoke result renders the endpoint-unreachable warn chip', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models'))
        return jsonResponse({ binary: 'claude', cached: false, models: [] })
      if (url.includes('/api/runtimes'))
        return jsonResponse({
          runtimes: [
            {
              name: 'claude-code',
              protocol: 'claude-code',
              binaryPath: null,
              isDefault: false,
              ...NULL_PROFILE,
              enabled: true,
              lastProbe: {
                outcome: 'network-blocked',
                conforms: false,
                detail: 'binary started but the model endpoint is unreachable ...',
                sawNonce: false,
                sawEnvelope: false,
                exitCode: 1,
              },
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })
      return jsonResponse({})
    })
    wrap(<RuntimeList />)
    await waitFor(() => expect(document.querySelector('.runtime-list__name')).toBeTruthy())
    const chip = screen.getByText('endpoint unreachable')
    expect(chip).toBeTruthy()
    expect(screen.queryByText('auth missing')).toBeNull()
    expect(chip.closest('.status-chip')?.className).toContain('status-chip--warn')
  })

  test('RFC-153: every row is editable AND deletable (Test / Edit / Delete on all three)', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    // three rows → three Test + three Edit + three Delete (preseeded rows are
    // ordinary now; the server, not the UI, blocks deleting the default / a
    // referenced row).
    expect(screen.getAllByRole('button', { name: /^Test$/ }).length).toBe(3)
    expect(screen.getAllByRole('button', { name: /^Edit$/ }).length).toBe(3)
    expect(screen.getAllByRole('button', { name: /^Delete$/ }).length).toBe(3)
  })

  test('the config-default row shows the default marker + no "Set default" button', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    // opencode is the default → carries the "default" chip; the other two non-default
    // rows each expose a "Set default" button (so exactly two of them).
    expect(screen.getByText('default')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /set default/i }).length).toBe(2)
    // the default row itself is accented via the --default modifier class.
    expect(document.querySelector('.runtime-list__row--default')).toBeTruthy()
  })

  test('"Add runtime" opens the form dialog with the public Dialog chrome', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // the protocol picker is the public Select combobox, not a raw <select>.
    expect(screen.getByRole('combobox', { name: /protocol/i })).toBeTruthy()
  })

  // Codex P3 regression: the claude spawn path consumes ONLY `model`, so a
  // claude-code runtime must NOT offer variant/temperature/steps/maxSteps inputs
  // (a saved value would silently do nothing). opencode keeps the full profile.
  test('claude-code runtime form shows only Model — no Max steps / variant / temperature', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    // Default protocol is opencode → the full profile incl. Max steps renders.
    expect(screen.getByText('Max steps')).toBeTruthy()
    // Switch the protocol Select to Claude Code (public combobox: click → mouseDown option).
    fireEvent.click(screen.getByRole('combobox', { name: /protocol/i }))
    const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement
    const claudeOpt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('Claude Code'),
    )!
    fireEvent.mouseDown(claudeOpt)
    // Model stays; the opencode-only params are gone; the explanatory hint shows.
    expect(screen.getByText('Model')).toBeTruthy()
    expect(screen.queryByText('Max steps')).toBeNull()
    expect(screen.queryByText('Variant')).toBeNull()
    expect(screen.queryByText('Temperature')).toBeNull()
    expect(screen.getByText(/use only the model/i)).toBeTruthy()
  })

  // RFC-114: editing an existing runtime lists ITS binary's models — the model
  // fetch must carry ?runtime=<that runtime's name> (a custom opencode fork shows
  // its own models, not the default opencode's).
  test('editing a custom runtime fetches models with ?runtime=<name> (RFC-114 D1)', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    // my-oc is the 3rd row (opencode / claude-code / my-oc) → its Edit button.
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[2]!)
    await waitFor(() =>
      expect(fetchUrls.some((u) => /\/api\/runtime\/models\?.*runtime=my-oc/.test(u))).toBe(true),
    )
  })

  // RFC-114 O1(a): a NEW custom binary can't be listed before it's saved — the
  // model field is free-text with a "save first" hint, and the form must NOT
  // fetch the default opencode model list (which would mislead).
  test('new-runtime form: model is free-text + save-first hint, no model fetch (RFC-114 O1a)', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    expect(screen.getByText(/save the runtime first/i)).toBeTruthy()
    // no ModelSelect → no /api/runtime/models fetch for the new form.
    expect(fetchUrls.some((u) => u.includes('/api/runtime/models'))).toBe(false)
  })

  // RFC-114 Codex P2-2: a runtime's model list is cached per-name with
  // staleTime:Infinity. Deleting (or saving a changed binary for) that runtime
  // must invalidate ['runtime','models','rt',<name>] — else a same-name re-create
  // or a reopened edit serves the OLD binary's models.
  test('deleting a runtime invalidates its per-name model query (RFC-114 P2-2)', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    })
    const spy = vi.spyOn(client, 'invalidateQueries')
    render(
      <QueryClientProvider client={client}>
        <RuntimeList />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    // RFC-153: all three rows have a Delete button; my-oc is the 3rd (opencode /
    // claude-code / my-oc) → click its Delete to invalidate its per-name model query.
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[2]!)
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['runtime', 'models', 'rt', 'my-oc'] }),
      ),
    )
  })
})
