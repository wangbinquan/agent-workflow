// RFC-112 PR-D + RFC-113 + RFC-153 (frontend) — the runtime registry list replaces
// the two stacked RFC-111 status cards. Locks: preseeded (opencode / claude-code)
// + custom rows render alike; every row is editable (name/protocol identity locked
// in the dialog) AND deletable (RFC-153 removed the built-in read-only flag +
// badge; the server 409s only on the effective default / a referenced row); the
// config-default row shows the in-table "default" marker + no "Set default"
// button; a conforming smoke result shows its status; "Add runtime" opens the form
// dialog (public Dialog chrome, not a raw modal).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeList } from '../src/components/RuntimeList'
import i18n from '../src/i18n'
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
let configPutBodies: unknown[] = []

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://runtime-list-${crypto.randomUUID()}.test`)
  setToken('tok')
  fetchUrls = []
  configPutBodies = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    fetchUrls.push(url)
    if (url.includes('/api/config')) {
      const method = init?.method ?? 'GET'
      if (method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        configPutBodies.push(body)
        return jsonResponse({ ...DEFAULT_CONFIG, defaultRuntime: body.defaultRuntime })
      }
      return jsonResponse({ ...DEFAULT_CONFIG, defaultRuntime: 'opencode' })
    }
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

  test('legacy OpenCode without a model is danger-marked and cannot Test or become default', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models'))
        return jsonResponse({ binary: 'opencode', cached: true, models: [] })
      if (url.includes('/api/runtimes'))
        return jsonResponse({
          runtimes: RUNTIMES_BODY.runtimes.map((runtime) =>
            runtime.name === 'opencode'
              ? { ...runtime, isDefault: false, binaryPath: '/usr/local/bin/opencode' }
              : runtime.name === 'claude-code'
                ? { ...runtime, isDefault: true }
                : runtime,
          ),
        })
      return jsonResponse({})
    })

    wrap(<RuntimeList />)
    const chip = await screen.findByTestId('runtime-model-missing-opencode')
    expect(chip.textContent).toBe('model required')
    expect(chip.closest('.status-chip')?.className).toContain('status-chip--danger')
    const runtimeRow = chip.closest('.runtime-list__row')
    if (!(runtimeRow instanceof HTMLElement)) throw new Error('expected runtime row')
    expect(
      (within(runtimeRow).getByRole('button', { name: /^Test$/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (within(runtimeRow).getByRole('button', { name: /^Set default$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  test('editing a model-less OpenCode row enables Save and Test only after selecting a model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models'))
        return jsonResponse({
          binary: '/usr/local/bin/opencode',
          cached: true,
          models: [
            {
              id: 'anthropic/opus',
              provider: 'anthropic',
              modelID: 'opus',
              name: 'Opus',
            },
          ],
        })
      if (url.includes('/api/runtimes'))
        return jsonResponse({
          runtimes: RUNTIMES_BODY.runtimes.map((runtime) =>
            runtime.name === 'opencode'
              ? { ...runtime, binaryPath: '/usr/local/bin/opencode' }
              : runtime,
          ),
        })
      return jsonResponse({})
    })

    wrap(<RuntimeList />)
    await screen.findByTestId('runtime-model-missing-opencode')
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Edit runtime' })
    const save = within(dialog).getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    const testBinary = within(dialog).getByRole('button', {
      name: /^Test binary$/,
    }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(testBinary.disabled).toBe(true)
    expect(
      within(dialog).getByText(
        'Select an explicit model before saving or testing this OpenCode runtime.',
      ),
    ).toBeTruthy()

    const modelSelect = within(dialog).getAllByRole('combobox')[1] as HTMLButtonElement
    await waitFor(() => expect(modelSelect.disabled).toBe(false))
    fireEvent.click(modelSelect)
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText('Opus'))
    expect(save.disabled).toBe(false)
    expect(testBinary.disabled).toBe(false)
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

  test('persisted execution-identity failure renders actionable English copy without raw tokens', async () => {
    await i18n.changeLanguage('en-US')
    const raw = 'execution-identity-sandbox-required RAW_BACKEND_SECRET'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (url.includes('/api/runtime/models'))
        return jsonResponse({ binary: 'opencode', cached: false, models: [] })
      if (url.includes('/api/runtimes'))
        return jsonResponse({
          runtimes: [
            {
              name: 'opencode',
              protocol: 'opencode',
              binaryPath: null,
              isDefault: true,
              ...NULL_PROFILE,
              model: 'openai/gpt-5.6',
              enabled: true,
              lastProbe: {
                outcome: 'execution-identity-failed',
                conforms: false,
                detail: raw,
                failureCode: 'execution-identity-sandbox-required',
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
    const chip = screen.getByText('execution identity failed')
    expect(chip.closest('.status-chip')?.className).toContain('status-chip--danger')
    expect(screen.queryByText('runtimes.smoke.execution-identity-failed')).toBeNull()
    expect(
      screen.getByText(
        'This OpenCode run requires the secure Linux sandbox, but it is unavailable.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Run the daemon on a supported Linux host with the required sandbox enabled.',
      ),
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain(raw)
    expect(document.body.textContent).not.toContain('execution-identity-sandbox-required')
  })

  test('Test binary result renders actionable Chinese copy without raw tokens', async () => {
    await i18n.changeLanguage('zh-CN')
    const raw = 'execution-identity-sandbox-required RAW_BACKEND_SECRET'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/api/runtimes/probe')) {
        return jsonResponse({
          smoke: {
            outcome: 'execution-identity-failed',
            conforms: false,
            detail: raw,
            failureCode: 'execution-identity-sandbox-required',
            sawNonce: false,
            sawEnvelope: false,
            exitCode: 1,
          },
        })
      }
      if (url.includes('/api/runtime/models'))
        return jsonResponse({ binary: 'opencode', cached: false, models: [] })
      if (url.includes('/api/runtimes')) return jsonResponse(RUNTIMES_BODY)
      return jsonResponse({})
    })

    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /^编辑$/ })[2]!)
    const dialog = await screen.findByRole('dialog', { name: '编辑运行时' })
    fireEvent.click(within(dialog).getByRole('button', { name: '测试二进制' }))

    expect(
      await within(dialog).findByText('本次 OpenCode 运行要求安全 Linux 沙箱，但当前不可用。'),
    ).toBeTruthy()
    expect(
      within(dialog).getByText('请在支持的 Linux 主机上运行 daemon，并启用所需沙箱。'),
    ).toBeTruthy()
    expect(dialog.textContent).not.toContain(raw)
    expect(dialog.textContent).not.toContain('execution-identity-sandbox-required')
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

  test('Set default queues exactly the defaultRuntime patch', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    const myOcRow = Array.from(document.querySelectorAll('.runtime-list__row')).find(
      (row) => row.querySelector('.runtime-list__name')?.textContent === 'my-oc',
    )
    fireEvent.click(
      Array.from(myOcRow?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Set default',
      )!,
    )
    await waitFor(() => expect(configPutBodies).toHaveLength(1))
    expect(configPutBodies[0]).toEqual({ defaultRuntime: 'my-oc' })
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
    // RFC-201: deletion is transactional. Open the shared confirmation, then
    // confirm the exact row before the mutation invalidates its model cache.
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[2]!)
    const dialog = screen.getByRole('dialog', { name: /delete runtime "my-oc"/i })
    expect(dialog).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }))
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['runtime', 'models', 'rt', 'my-oc'] }),
      ),
    )
  })

  test('runtime deletion requires confirmation and cancel restores focus to its trigger', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    const trigger = screen.getAllByRole('button', { name: /^Delete$/ })[2]!
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: /delete runtime "my-oc"/i })
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$/ }))

    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(fetchUrls.some((url) => url.includes('/api/runtimes/my-oc'))).toBe(false)
  })

  test('successful deletion removes the trigger before close and focuses the stable list heading', async () => {
    let deleted = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL | Request).toString())
      const method = init?.method ?? 'GET'
      if (url.pathname === '/api/runtimes/my-oc' && method === 'DELETE') {
        deleted = true
        return jsonResponse({})
      }
      if (url.pathname === '/api/runtimes') {
        return jsonResponse({
          runtimes: deleted
            ? RUNTIMES_BODY.runtimes.filter((runtime) => runtime.name !== 'my-oc')
            : RUNTIMES_BODY.runtimes,
        })
      }
      return jsonResponse({})
    })
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[2]!)
    const dialog = screen.getByRole('dialog', { name: /delete runtime "my-oc"/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }))

    await waitFor(() => expect(screen.queryByText('my-oc')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Runtimes' }))
  })

  test('embedded list deletion falls back to its owning section heading when no next card exists', async () => {
    let deleted = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL | Request).toString())
      const method = init?.method ?? 'GET'
      if (url.pathname === '/api/runtimes/my-oc' && method === 'DELETE') {
        deleted = true
        return jsonResponse({})
      }
      if (url.pathname === '/api/runtimes') {
        return jsonResponse({ runtimes: deleted ? [] : [RUNTIMES_BODY.runtimes[2]!] })
      }
      return jsonResponse({})
    })
    const fallbackRef = { current: null as HTMLElement | null }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    })
    render(
      <QueryClientProvider client={client}>
        <h2
          ref={(node) => {
            fallbackRef.current = node
          }}
          tabIndex={-1}
        >
          Runtime section
        </h2>
        <RuntimeList showHeading={false} restoreFocusFallbackRef={fallbackRef} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
    const dialog = screen.getByRole('dialog', { name: /delete runtime "my-oc"/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }))

    await waitFor(() => expect(screen.queryByText('my-oc')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Runtime section' }))
  })

  // RFC-154: config-dir injection overrides — two optional fields whose
  // placeholders show the SELECTED protocol's defaults (a custom fork may have
  // renamed the env var / leaf dir it reads its config dir through).
  test('RFC-154: config-dir fields render with protocol-default placeholders that follow the protocol switch', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    const envInput = screen.getByTestId('runtime-config-dir-env') as HTMLInputElement
    const nameInput = screen.getByTestId('runtime-config-dir-name') as HTMLInputElement
    // Default protocol = opencode → opencode defaults as placeholders.
    expect(envInput.placeholder).toBe('OPENCODE_CONFIG_DIR')
    expect(nameInput.placeholder).toBe('.opencode')
    // Switch to Claude Code → placeholders follow.
    fireEvent.click(screen.getByRole('combobox', { name: /protocol/i }))
    const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement
    const claudeOpt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('Claude Code'),
    )!
    fireEvent.mouseDown(claudeOpt)
    expect(envInput.placeholder).toBe('CLAUDE_CONFIG_DIR')
    expect(nameInput.placeholder).toBe('.claude')
  })

  // RFC-154: empty fields submit as null (= unset → protocol default); filled
  // fields submit trimmed values.
  test('RFC-154: create submits configDirEnv/configDirName — filled → trimmed, empty → null', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString()
      if (init?.method === 'POST' && url.endsWith('/api/runtimes')) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({ runtime: {} })
      }
      if (url.includes('/api/runtimes')) return jsonResponse(RUNTIMES_BODY)
      return jsonResponse({})
    })
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    fireEvent.change(screen.getByTestId('runtime-name'), { target: { value: 'myfork' } })
    fireEvent.change(screen.getByRole('textbox', { name: /^Model/ }), {
      target: { value: 'openai/gpt-5.6' },
    })
    fireEvent.change(screen.getByTestId('runtime-config-dir-env'), {
      target: { value: '  MYFORK_CONFIG_DIR  ' },
    })
    // name left empty → null.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      name: 'myfork',
      configDirEnv: 'MYFORK_CONFIG_DIR',
      configDirName: null,
    })
  })

  // RFC-154 (Codex impl-gate P3): invalid overrides are blocked AT THE FORM —
  // inline error (shared predicate, same rule the backend throws from) + a
  // disabled Save. Reserved env names and traversal leaf names never reach the
  // wire from the dialog.
  test('RFC-154: invalid config-dir values show inline errors and disable Save', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    fireEvent.change(screen.getByTestId('runtime-name'), { target: { value: 'myfork' } })
    fireEvent.change(screen.getByRole('textbox', { name: /^Model/ }), {
      target: { value: 'openai/gpt-5.6' },
    })
    const saveBtn = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    // Reserved env name → reserved error + Save disabled.
    fireEvent.change(screen.getByTestId('runtime-config-dir-env'), {
      target: { value: 'OPENCODE_CONFIG_CONTENT' },
    })
    expect(screen.getByRole('alert').textContent).toMatch(/reserved/i)
    expect(saveBtn.disabled).toBe(true)
    // Fix the env, break the name with traversal → leaf error + still disabled.
    fireEvent.change(screen.getByTestId('runtime-config-dir-env'), {
      target: { value: 'MYFORK_CONFIG_DIR' },
    })
    fireEvent.change(screen.getByTestId('runtime-config-dir-name'), {
      target: { value: '../evil' },
    })
    expect(screen.getByRole('alert').textContent).toMatch(/single directory name/i)
    expect(saveBtn.disabled).toBe(true)
    // Clear both → enabled again.
    fireEvent.change(screen.getByTestId('runtime-config-dir-name'), { target: { value: '' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveBtn.disabled).toBe(false)
  })
})
