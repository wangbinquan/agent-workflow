// RFC-255 T8 — Settings → Runtime → Custom providers.
//
// Why this test exists: this card is the only way to configure a private
// gateway (the daemon seals the credential, so there is no hand-editable
// equivalent and the CLI refuses the key). The behaviour that is easy to get
// wrong, and that breaks a production deployment silently, is the credential
// round trip: the API returns a mask, and an administrator editing the endpoint
// must not have to retype the secret — nor may the mask be sent as if it were
// one. The assertions below lock that, plus the client-side guard against
// claiming a built-in catalog id (which would re-point that catalog provider).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CUSTOM_PROVIDER_API_KEY_MASK, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CustomProviderCard } from '../src/components/CustomProviderCard'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const STORED = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: '@ai-sdk/openai-compatible',
  baseURL: 'https://gw.internal.example/v1',
  // Exactly what a GET returns: the mask, never the credential.
  apiKey: CUSTOM_PROVIDER_API_KEY_MASK,
  models: [{ id: 'deepseek-v3' }, { id: 'qwen-max' }],
  enabled: true,
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

let configPutBodies: Record<string, unknown>[] = []
let storedProviders: unknown[] = []

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://custom-provider-${crypto.randomUUID()}.test`)
  setToken('tok')
  configPutBodies = []
  storedProviders = [STORED]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/config')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        configPutBodies.push(body)
        if (Array.isArray(body.customProviders)) storedProviders = body.customProviders
        return jsonResponse({ ...DEFAULT_CONFIG, customProviders: storedProviders })
      }
      return jsonResponse({ ...DEFAULT_CONFIG, customProviders: storedProviders })
    }
    return jsonResponse({})
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const lastPatch = (): Record<string, unknown>[] =>
  (configPutBodies.at(-1)?.customProviders ?? []) as Record<string, unknown>[]

describe('RFC-255 custom provider card', () => {
  test('lists a configured gateway with its endpoint and model count', async () => {
    wrap(<CustomProviderCard />)
    expect(await screen.findByText('Internal Gateway')).toBeTruthy()
    expect(screen.getByText('https://gw.internal.example/v1')).toBeTruthy()
    expect(screen.getByText('2 models')).toBeTruthy()
  })

  test('shows an empty state when nothing is configured', async () => {
    storedProviders = []
    wrap(<CustomProviderCard />)
    // Rendered by the shared QueryState primitive, so assert the visible copy
    // rather than a testid this component no longer owns.
    expect(await screen.findByText('No custom providers configured yet.')).toBeTruthy()
  })

  test('editing the endpoint keeps the stored credential', async () => {
    wrap(<CustomProviderCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    // The key field starts blank — the stored secret is never rendered.
    const keyInput = screen.getByTestId('custom-provider-apikey') as HTMLInputElement
    expect(keyInput.value).toBe('')
    const urlInput = screen.getByTestId('custom-provider-baseurl')
    fireEvent.change(urlInput, { target: { value: 'https://gw.internal.example/v2' } })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    await waitFor(() => expect(configPutBodies.length).toBe(1))
    const saved = lastPatch()[0]!
    expect(saved.baseURL).toBe('https://gw.internal.example/v2')
    // The mask is what "keep the stored key" looks like on the wire.
    expect(saved.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)
  })

  test('typing a new key sends that key, not the mask', async () => {
    wrap(<CustomProviderCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByTestId('custom-provider-apikey'), {
      target: { value: 'sk-rotated' },
    })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    await waitFor(() => expect(configPutBodies.length).toBe(1))
    expect(lastPatch()[0]!.apiKey).toBe('sk-rotated')
  })

  test('creating a gateway requires an id, endpoint, models and a key', async () => {
    storedProviders = []
    wrap(<CustomProviderCard />)
    fireEvent.click(await screen.findByTestId('custom-provider-add'))
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(configPutBodies.length).toBe(0)

    fireEvent.change(screen.getByTestId('custom-provider-id'), { target: { value: 'newgw' } })
    fireEvent.change(screen.getByTestId('custom-provider-baseurl'), {
      target: { value: 'https://new.example/v1' },
    })
    fireEvent.change(screen.getByTestId('custom-provider-models-input'), {
      target: { value: 'model-a' },
    })
    fireEvent.keyDown(screen.getByTestId('custom-provider-models-input'), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    // Still refused: a brand-new entry has no stored secret to fall back on.
    expect(configPutBodies.length).toBe(0)

    fireEvent.change(screen.getByTestId('custom-provider-apikey'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    await waitFor(() => expect(configPutBodies.length).toBe(1))
    const created = lastPatch()[0]!
    expect(created.id).toBe('newgw')
    expect(created.apiKey).toBe('sk-new')
    expect(created.models).toEqual([{ id: 'model-a' }])
    expect(created.npm).toBe('@ai-sdk/openai-compatible')
  })

  test('refuses a built-in catalog id before it can reach the daemon', async () => {
    storedProviders = []
    wrap(<CustomProviderCard />)
    fireEvent.click(await screen.findByTestId('custom-provider-add'))
    fireEvent.change(screen.getByTestId('custom-provider-id'), { target: { value: 'anthropic' } })
    fireEvent.change(screen.getByTestId('custom-provider-baseurl'), {
      target: { value: 'https://gw.example/v1' },
    })
    fireEvent.change(screen.getByTestId('custom-provider-apikey'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/catalog provider/i)).toBeTruthy()
    expect(configPutBodies.length).toBe(0)
  })

  test('rejects an endpoint carrying a ${} placeholder', async () => {
    storedProviders = []
    wrap(<CustomProviderCard />)
    fireEvent.click(await screen.findByTestId('custom-provider-add'))
    fireEvent.change(screen.getByTestId('custom-provider-id'), { target: { value: 'gw2' } })
    fireEvent.change(screen.getByTestId('custom-provider-baseurl'), {
      target: { value: 'https://gw.example/${HOME}' },
    })
    fireEvent.change(screen.getByTestId('custom-provider-apikey'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByTestId('custom-provider-save'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(configPutBodies.length).toBe(0)
  })

  test('disabling a gateway preserves its credential', async () => {
    wrap(<CustomProviderCard />)
    const toggle = await screen.findByRole('checkbox', { name: 'Enabled' })
    fireEvent.click(toggle)
    await waitFor(() => expect(configPutBodies.length).toBe(1))
    const saved = lastPatch()[0]!
    expect(saved.enabled).toBe(false)
    expect(saved.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)
  })
})
