// RFC-255 T3 — the runtime single source of truth for custom providers.
//
// Why this test exists: the endpoint a run is verified against and the endpoint
// it actually dials come from two different OpenCode fields (`api` →
// model.api.url, provider.ts:1450; `options.baseURL` → the SDK, :1693-1695).
// A builder that set one without the other would pass admission while serving
// traffic somewhere else. These assertions also lock the two exclusions the
// design gate produced: the credential never enters the config (so rotating a
// key does not break resume) and the display name never enters the RUNTIME
// section (so renaming a gateway does not break resume either).

import { describe, expect, test } from 'bun:test'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  admittedCustomFromExpectedConfig,
  buildControlledProviderSection,
  buildCustomProviderAuth,
  buildEnumerationProviderSection,
  customProvidersProjection,
  findCustomProvider,
  listUsableCustomProviders,
} from '@/services/runtime/opencode/customProvider'
import { buildControlledOpencodeConfig } from '@/services/runtime/opencode/hermetic'
import { businessOpencodeIdentityDigest } from '@/services/runtime/opencode/executionIdentity'
import { CUSTOM_PROVIDER_NPM, type CustomProviderEntryWire } from '@agent-workflow/shared'

const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 7))
const PLAINTEXT_KEY = 'sk-gateway-super-secret'

const entry: CustomProviderEntryWire = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: 'https://gw.internal.example/v1',
  apiKey: secretBox.seal(PLAINTEXT_KEY),
  models: [{ id: 'deepseek-v3' }, { id: 'qwen-max', name: 'Qwen Max' }],
  enabled: true,
}

const cfg = { customProviders: [entry] } as never

describe('RFC-255 controlled provider section', () => {
  test('writes the endpoint into both fields from one value', () => {
    const section = buildControlledProviderSection(entry)
    expect(section).toEqual({
      mygw: {
        npm: CUSTOM_PROVIDER_NPM,
        api: 'https://gw.internal.example/v1',
        options: { baseURL: 'https://gw.internal.example/v1' },
        models: { 'deepseek-v3': {}, 'qwen-max': {} },
      },
    })
    const injected = section.mygw as Record<string, unknown>
    expect(injected.api).toBe((injected.options as Record<string, unknown>).baseURL)
  })

  test('the runtime section carries neither the credential nor the display name', () => {
    const serialized = JSON.stringify(buildControlledProviderSection(entry))
    expect(serialized).not.toContain(PLAINTEXT_KEY)
    expect(serialized).not.toContain(entry.apiKey)
    expect(serialized).not.toContain('apiKey')
    // Renaming must not change the identity digest, so the name stays out.
    expect(serialized).not.toContain('Internal Gateway')
    expect(serialized).not.toContain('Qwen Max')
  })

  test('an entry that lost its shape fails closed rather than injecting garbage', () => {
    expect(() => buildControlledProviderSection({ ...entry, models: [] })).toThrow()
    expect(() => buildControlledProviderSection({ ...entry, baseURL: 'ftp://x' })).toThrow()
    expect(() =>
      buildControlledProviderSection({ ...entry, npm: '@ai-sdk/anthropic' } as never),
    ).toThrow()
  })
})

describe('RFC-255 controlled config integration', () => {
  const baseInput = {
    name: 'auditor',
    prompt: 'p',
    description: 'd',
    model: 'mygw/deepseek-v3',
    toolOutputPattern: '/tmp/out/*',
    shellPath: '/bin/sh',
    allowShell: false,
  }

  test('the provider section reaches the frozen config without the key', () => {
    const config = buildControlledOpencodeConfig({
      ...baseInput,
      customProvider: buildControlledProviderSection(entry),
    })
    expect((config.provider as Record<string, unknown>).mygw).toBeDefined()
    expect(JSON.stringify(config)).not.toContain(PLAINTEXT_KEY)
  })

  test('a catalog run serializes exactly as it did before this key existed', () => {
    const withoutCustom = buildControlledOpencodeConfig(baseInput)
    expect(Object.hasOwn(withoutCustom, 'provider')).toBe(false)
  })
})

describe('RFC-255 credential handling', () => {
  test('unseals into OpenCode strict api shape', () => {
    const auth = buildCustomProviderAuth(entry, secretBox)
    expect(auth.providerID).toBe('mygw')
    expect(JSON.parse(auth.serialized)).toEqual({
      mygw: { type: 'api', key: PLAINTEXT_KEY },
    })
  })

  test('a key sealed with a different secret.key fails closed', () => {
    const otherBox = createSecretBoxFromKey(Buffer.alloc(32, 9))
    expect(() => buildCustomProviderAuth(entry, otherBox)).toThrow()
    expect(() => buildCustomProviderAuth({ ...entry, apiKey: '' }, secretBox)).toThrow()
  })
})

describe('RFC-255 lookup states', () => {
  test('distinguishes enabled, disabled and absent', () => {
    expect(findCustomProvider(cfg, 'mygw').state).toBe('enabled')
    expect(
      findCustomProvider({ customProviders: [{ ...entry, enabled: false }] } as never, 'mygw')
        .state,
    ).toBe('disabled')
    expect(findCustomProvider(cfg, 'anthropic').state).toBe('absent')
    expect(findCustomProvider({ customProviders: [] } as never, 'mygw').state).toBe('absent')
  })

  test('a hand-corrupted config entry reads as absent instead of being trusted', () => {
    // config.json is operator-editable, so PUT validation is not a guarantee.
    const corrupted = { customProviders: [{ ...entry, baseURL: 'https://gw/${HOME}' }] } as never
    expect(listUsableCustomProviders(corrupted)).toEqual([])
    expect(findCustomProvider(corrupted, 'mygw').state).toBe('absent')
  })
})

describe('RFC-255 enumeration section', () => {
  test('keeps display names for the picker and still no credential', () => {
    const section = buildEnumerationProviderSection(cfg)
    const mygw = section.mygw as Record<string, unknown>
    expect(mygw.name).toBe('Internal Gateway')
    expect((mygw.models as Record<string, unknown>)['qwen-max']).toEqual({ name: 'Qwen Max' })
    expect(JSON.stringify(section)).not.toContain(PLAINTEXT_KEY)
  })

  test('disabled entries disappear from enumeration', () => {
    const disabled = { customProviders: [{ ...entry, enabled: false }] } as never
    expect(buildEnumerationProviderSection(disabled)).toEqual({})
  })

  test('the projection changes with content and is stable across key order', () => {
    const baseline = customProvidersProjection(cfg)
    expect(customProvidersProjection(cfg)).toBe(baseline)
    const renamedModel = {
      customProviders: [{ ...entry, models: [{ id: 'deepseek-v3' }, { id: 'other' }] }],
    } as never
    expect(customProvidersProjection(renamedModel)).not.toBe(baseline)
    const disabled = { customProviders: [{ ...entry, enabled: false }] } as never
    expect(customProvidersProjection(disabled)).not.toBe(baseline)
    // A key rotation must NOT change the projection — it would evict the model
    // cache for no reason and, worse, imply the key is part of identity.
    const rotated = { customProviders: [{ ...entry, apiKey: secretBox.seal('sk-new') }] } as never
    expect(customProvidersProjection(rotated)).toBe(baseline)
  })
})

describe('RFC-255 admission recovery', () => {
  test('round-trips the injected section back into admission values', () => {
    const config = buildControlledOpencodeConfig({
      name: 'auditor',
      prompt: 'p',
      description: 'd',
      model: 'mygw/deepseek-v3',
      toolOutputPattern: '/tmp/out/*',
      shellPath: '/bin/sh',
      allowShell: false,
      customProvider: buildControlledProviderSection(entry),
    })
    expect(admittedCustomFromExpectedConfig(config, 'mygw')).toEqual({
      id: 'mygw',
      npm: CUSTOM_PROVIDER_NPM,
      baseURL: 'https://gw.internal.example/v1',
      modelIds: ['deepseek-v3', 'qwen-max'],
    })
  })

  test('returns undefined for catalog runs and malformed sections', () => {
    expect(admittedCustomFromExpectedConfig({}, 'mygw')).toBeUndefined()
    expect(admittedCustomFromExpectedConfig({ provider: {} }, 'mygw')).toBeUndefined()
    expect(admittedCustomFromExpectedConfig(null, 'mygw')).toBeUndefined()
    expect(admittedCustomFromExpectedConfig({ provider: { mygw: 'x' } }, 'mygw')).toBeUndefined()
    // `constructor` is a legal provider id; a prototype hit must not pass.
    expect(admittedCustomFromExpectedConfig({ provider: {} }, 'constructor')).toBeUndefined()
  })
})

// AC-6 — the headline identity contract, asserted directly on the digest.
//
// Why this test exists: the whole reason the credential travels outside the
// config, and the display name never enters the runtime section, is so that
// rotating a key or renaming a gateway does not invalidate a running task's
// resume. Nothing else locks that; a future refactor that "tidied" the key or
// the name into the provider section would break resume for every in-flight
// task and no test would notice.
describe('RFC-255 execution identity semantics', () => {
  const digestFor = (e: CustomProviderEntryWire): string =>
    businessOpencodeIdentityDigest({
      config: buildControlledOpencodeConfig({
        name: 'auditor',
        prompt: 'p',
        description: 'd',
        model: 'mygw/deepseek-v3',
        toolOutputPattern: '/tmp/out/*',
        // The digest requires the shell to live inside the run seal.
        shellPath: '/tmp/seal/shell/sh',
        allowShell: false,
        customProvider: buildControlledProviderSection(e),
      }),
      agent: 'auditor',
      model: { providerID: 'mygw', modelID: 'deepseek-v3' },
      binaryDigest: 'a'.repeat(64),
      sealRoot: '/tmp/seal',
    })

  const baseline = () => digestFor(entry)

  test('rotating the credential leaves the identity untouched — resume survives', () => {
    expect(digestFor({ ...entry, apiKey: secretBox.seal('sk-rotated') })).toBe(baseline())
  })

  test('renaming the gateway or a model leaves the identity untouched', () => {
    expect(digestFor({ ...entry, name: 'Renamed Gateway' })).toBe(baseline())
    expect(
      digestFor({ ...entry, models: [{ id: 'deepseek-v3', name: 'DS v3' }, { id: 'qwen-max' }] }),
    ).toBe(baseline())
  })

  test('changing the endpoint or the model list IS an identity change — resume is refused', () => {
    expect(digestFor({ ...entry, baseURL: 'https://gw.internal.example/v2' })).not.toBe(baseline())
    // A trailing slash is a different endpoint, exactly as admission treats it.
    expect(digestFor({ ...entry, baseURL: 'https://gw.internal.example/v1/' })).not.toBe(baseline())
    expect(digestFor({ ...entry, models: [{ id: 'deepseek-v3' }] })).not.toBe(baseline())
  })
})
