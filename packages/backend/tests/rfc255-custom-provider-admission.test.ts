// RFC-255 T4/T6 — admission of a custom gateway, and the planner three-state
// branch that decides whether one is used at all.
//
// Why this test exists: the whole value of routing a private gateway through
// the verified path is that the endpoint is pinned. Admission is where that
// pin is enforced, so every way the report can disagree with what was admitted
// gets an explicit case here — including the model-superset case, which is the
// observable symptom of an id colliding with a catalog provider (OpenCode then
// merges the catalog in and re-points all of its models at the gateway).
//
// The disabled-provider branch is locked here too: an earlier design let it
// fall through to the generic credential channels, which produces a late
// `provider-untrusted` when the host happens to have a stale auth.json entry,
// and — for an id matching the credential-env table — silently runs against the
// vendor's own endpoint with the daemon's key.

import { describe, expect, test } from 'bun:test'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  buildControlledProviderSection,
  resolveProviderCredential,
} from '@/services/runtime/opencode/customProvider'
import { verifySelectedProviderInventory } from '@/services/runtime/opencode/verifiedLauncher'
import { CUSTOM_PROVIDER_NPM, type CustomProviderEntryWire } from '@agent-workflow/shared'

const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 3))
const BASE_URL = 'https://gw.internal.example/v1'

const entry: CustomProviderEntryWire = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: BASE_URL,
  apiKey: secretBox.seal('sk-gateway'),
  models: [{ id: 'deepseek-v3' }, { id: 'qwen-max' }],
  enabled: true,
}

const selected = { providerID: 'mygw', modelID: 'deepseek-v3' }
const admitted = {
  id: 'mygw',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: BASE_URL,
  modelIds: ['deepseek-v3', 'qwen-max'],
}

function reportedModel(id: string, url = BASE_URL): Record<string, unknown> {
  return {
    id,
    providerID: 'mygw',
    api: { id, url, npm: CUSTOM_PROVIDER_NPM },
    name: id,
    capabilities: {},
    cost: {},
    limit: {},
    status: 'active',
    options: {},
    headers: {},
    release_date: '',
  }
}

function inventory(
  overrides: {
    source?: string
    optionsBaseURL?: string
    models?: Record<string, unknown>
  } = {},
): unknown {
  return {
    providers: [
      {
        id: 'mygw',
        name: 'Internal Gateway',
        source: overrides.source ?? 'config',
        env: [],
        options: { baseURL: overrides.optionsBaseURL ?? BASE_URL },
        models: overrides.models ?? {
          'deepseek-v3': reportedModel('deepseek-v3'),
          'qwen-max': reportedModel('qwen-max'),
        },
      },
    ],
    default: { mygw: 'deepseek-v3' },
  }
}

describe('RFC-255 custom provider admission', () => {
  test('accepts a report that matches the admitted endpoint exactly', () => {
    expect(() => verifySelectedProviderInventory(inventory(), selected, admitted)).not.toThrow()
  })

  test('rejects a reported url that drifted from the admitted one', () => {
    const drifted = inventory({
      models: {
        'deepseek-v3': reportedModel('deepseek-v3', 'https://evil.example/v1'),
        'qwen-max': reportedModel('qwen-max'),
      },
    })
    expect(() => verifySelectedProviderInventory(drifted, selected, admitted)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  test('rejects when the SDK endpoint disagrees with the reported one', () => {
    // `api.url` is what admission reads; `options.baseURL` is what actually
    // gets dialed. Verifying only the first would leave the served endpoint
    // free to differ.
    const split = inventory({ optionsBaseURL: 'https://elsewhere.example/v1' })
    expect(() => verifySelectedProviderInventory(split, selected, admitted)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  test('rejects a trailing-slash mismatch — the comparison is byte-exact', () => {
    const slashed = inventory({ optionsBaseURL: `${BASE_URL}/` })
    expect(() => verifySelectedProviderInventory(slashed, selected, admitted)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  test('rejects a provider that no longer reports itself as config-sourced', () => {
    for (const source of ['env', 'api', 'custom']) {
      expect(() =>
        verifySelectedProviderInventory(inventory({ source }), selected, admitted),
      ).toThrow('execution-identity-provider-untrusted')
    }
  })

  test('rejects a model set larger than what the administrator listed', () => {
    // The symptom of a catalog-id collision: OpenCode merged the catalog's own
    // models in, and every one of them now points at the gateway.
    const superset = inventory({
      models: {
        'deepseek-v3': reportedModel('deepseek-v3'),
        'qwen-max': reportedModel('qwen-max'),
        'claude-sonnet-4': reportedModel('claude-sonnet-4'),
      },
    })
    expect(() => verifySelectedProviderInventory(superset, selected, admitted)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  test('a smaller reported set is allowed — the gateway may retire a model', () => {
    const subset = inventory({ models: { 'deepseek-v3': reportedModel('deepseek-v3') } })
    expect(() => verifySelectedProviderInventory(subset, selected, admitted)).not.toThrow()
  })

  test('rejects an npm that differs from the admitted implementation', () => {
    const swapped = inventory()
    const provider = (swapped as { providers: Record<string, never>[] })
      .providers[0] as unknown as {
      models: Record<string, { api: { npm: string } }>
    }
    provider.models['deepseek-v3']!.api.npm = '@ai-sdk/anthropic'
    expect(() => verifySelectedProviderInventory(swapped, selected, admitted)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  test('catalog runs keep their previous behaviour when no custom entry is admitted', () => {
    const catalog = {
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'env',
          env: ['OPENAI_API_KEY'],
          options: {},
          models: {
            'gpt-5.6': {
              id: 'gpt-5.6',
              providerID: 'openai',
              api: { id: 'gpt-5.6', url: 'https://api.openai.com', npm: '@ai-sdk/openai' },
              name: 'GPT',
              capabilities: {},
              cost: {},
              limit: {},
              status: 'active',
              options: {},
              headers: {},
              release_date: '',
            },
          },
        },
      ],
      default: { openai: 'gpt-5.6' },
    }
    const openaiModel = { providerID: 'openai', modelID: 'gpt-5.6' }
    expect(() => verifySelectedProviderInventory(catalog, openaiModel)).not.toThrow()
    expect(() => verifySelectedProviderInventory(catalog, openaiModel, undefined)).not.toThrow()
  })
})

describe('RFC-255 planner credential resolution', () => {
  const deps = (entries: CustomProviderEntryWire[]) => ({
    loadCustomProviderConfig: () => ({ customProviders: entries }) as never,
    secretBox,
  })

  test('an enabled gateway supplies both the section and the credential', async () => {
    const resolved = await resolveProviderCredential('mygw', {}, deps([entry]))
    expect(resolved.customProvider).toEqual(buildControlledProviderSection(entry))
    expect(JSON.parse(resolved.auth.serialized)).toEqual({
      mygw: { type: 'api', key: 'sk-gateway' },
    })
  })

  test('a disabled gateway fails immediately instead of falling through', async () => {
    // Falling through would consult the host's native auth.json, where a stale
    // entry for this id makes planning succeed and the run die later.
    await expect(
      resolveProviderCredential('mygw', {}, deps([{ ...entry, enabled: false }])),
    ).rejects.toThrow('execution-identity-custom-provider-disabled')
  })

  test('a disabled gateway is not rescued by an environment variable', async () => {
    // The env channel would otherwise satisfy an id that also exists in the
    // credential table, quietly running against the vendor endpoint.
    await expect(
      resolveProviderCredential(
        'mygw',
        { OPENCODE_AUTH_CONTENT: JSON.stringify({ mygw: { type: 'api', key: 'sk-env' } }) },
        deps([{ ...entry, enabled: false }]),
      ),
    ).rejects.toThrow('execution-identity-custom-provider-disabled')
  })

  test('a catalog provider still resolves through the untouched three channels', async () => {
    const resolved = await resolveProviderCredential(
      'openai',
      { OPENAI_API_KEY: 'sk-openai' },
      deps([entry]),
    )
    expect(resolved.customProvider).toBeUndefined()
    expect(JSON.parse(resolved.auth.serialized)).toEqual({
      openai: { type: 'api', key: 'sk-openai' },
    })
  })

  test('a deleted gateway behaves exactly like a provider that never existed', async () => {
    await expect(resolveProviderCredential('mygw', {}, deps([]))).rejects.toThrow(
      'execution-identity-auth-invalid',
    )
  })
})
