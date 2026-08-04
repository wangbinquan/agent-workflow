// RFC-255 T2 — storage, masking and the save gate.
//
// Why this test exists: the credential lifecycle here has three failure modes
// that all look fine in a happy-path test.
//   1. Read-modify-write. The UI GETs the config, edits one field and PUTs the
//      whole object back. If the mask were treated as a value, that round trip
//      would overwrite every key with "••••••••" and every run would break.
//   2. Echo surfaces. The PUT response and `config get` are just as public as
//      the GET body; masking only the GET leaks the key on every save.
//   3. The CLI writes the same file. A gate living only in the route would let
//      `config set` store what the API rejects.
// Plus the at-rest properties: sealed on disk, file mode 0600.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { maskConfigForOutput, resolveCustomProvidersForSave } from '@/config/customProviderGate'
import { loadConfig, saveConfigRaw } from '@/config'
import { probeCatalogCollisionWith } from '@/services/runtime/opencode/catalogProbe'
import {
  CUSTOM_PROVIDER_API_KEY_MASK,
  CUSTOM_PROVIDER_NPM,
  DEFAULT_CONFIG,
  isReservedProviderId,
  RESERVED_PROVIDER_IDS,
  type Config,
  type CustomProviderEntryWire,
} from '@agent-workflow/shared'

const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 5))
const PLAINTEXT = 'sk-live-gateway-key'

const wireEntry: CustomProviderEntryWire = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: 'https://gw.internal.example/v1',
  apiKey: PLAINTEXT,
  models: [{ id: 'deepseek-v3' }],
  enabled: true,
}

const cfgWith = (providers: CustomProviderEntryWire[]): Config =>
  ({ ...DEFAULT_CONFIG, customProviders: providers }) as Config

/** The schema keeps stored entries as `unknown`; the gate is what types them. */
const providersOf = (cfg: Pick<Config, 'customProviders'>): CustomProviderEntryWire[] =>
  cfg.customProviders as CustomProviderEntryWire[]

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rfc255-config-'))
  return join(dir, 'config.json')
}

describe('RFC-255 masking', () => {
  test('replaces every stored credential on the way out', () => {
    const sealed = secretBox.seal(PLAINTEXT)
    const masked = maskConfigForOutput(cfgWith([{ ...wireEntry, apiKey: sealed }]))
    expect(providersOf(masked)[0]?.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)
    expect(JSON.stringify(masked)).not.toContain(sealed)
    expect(JSON.stringify(masked)).not.toContain(PLAINTEXT)
    // Everything else is untouched — the UI needs it to render the row.
    expect(providersOf(masked)[0]?.baseURL).toBe(wireEntry.baseURL)
    expect(providersOf(masked)[0]?.name).toBe('Internal Gateway')
  })

  test('a config without providers passes through unchanged', () => {
    const cfg = cfgWith([])
    expect(maskConfigForOutput(cfg)).toBe(cfg)
  })
})

describe('RFC-255 save gate', () => {
  test('seals a new credential instead of storing it verbatim', async () => {
    const saved = await resolveCustomProvidersForSave(cfgWith([]), cfgWith([wireEntry]), secretBox)
    expect(saved[0]?.apiKey).not.toBe(PLAINTEXT)
    expect(secretBox.unseal(saved[0]!.apiKey!)).toBe(PLAINTEXT)
  })

  test('the read-modify-write round trip preserves the stored credential', async () => {
    const sealed = secretBox.seal(PLAINTEXT)
    const current = cfgWith([{ ...wireEntry, apiKey: sealed }])
    // Exactly what the UI sends back: the masked GET body with one field edited.
    const echoed = maskConfigForOutput(current)
    const submitted = cfgWith([{ ...providersOf(echoed)[0]!, name: 'Renamed Gateway' }])
    const saved = await resolveCustomProvidersForSave(current, submitted, secretBox)
    expect(saved[0]?.apiKey).toBe(sealed)
    expect(secretBox.unseal(saved[0]!.apiKey!)).toBe(PLAINTEXT)
    expect(saved[0]?.name).toBe('Renamed Gateway')
  })

  // Preservation is a statement about a gateway, not about a name. Without
  // this, an admin-level actor who cannot READ the key (it is masked) could
  // still have it delivered to an endpoint of their choosing by editing the URL
  // and sending the mask — and the same rule blocks the id-swap variant, where
  // two entries trade names and each credential lands on the other's endpoint.
  test('moving an entry to a different endpoint requires the key again', async () => {
    const current = cfgWith([{ ...wireEntry, apiKey: secretBox.seal(PLAINTEXT) }])
    await expect(
      resolveCustomProvidersForSave(
        current,
        cfgWith([
          {
            ...wireEntry,
            apiKey: CUSTOM_PROVIDER_API_KEY_MASK,
            baseURL: 'https://attacker.example/v1',
          },
        ]),
        secretBox,
      ),
    ).rejects.toThrow('config-custom-provider-apikey-required')
  })

  test('swapping two ids cannot re-bind either credential', async () => {
    const a = {
      ...wireEntry,
      id: 'gw-a',
      baseURL: 'https://a.example/v1',
      apiKey: secretBox.seal('KEY-A'),
    }
    const b = {
      ...wireEntry,
      id: 'gw-b',
      baseURL: 'https://b.example/v1',
      apiKey: secretBox.seal('KEY-B'),
    }
    await expect(
      resolveCustomProvidersForSave(
        cfgWith([a, b]),
        cfgWith([
          { ...a, baseURL: b.baseURL, apiKey: CUSTOM_PROVIDER_API_KEY_MASK },
          { ...b, baseURL: a.baseURL, apiKey: CUSTOM_PROVIDER_API_KEY_MASK },
        ]),
        secretBox,
      ),
    ).rejects.toThrow('config-custom-provider-apikey-required')
  })

  test('omitting the key entirely also means "keep it"', async () => {
    const sealed = secretBox.seal(PLAINTEXT)
    const current = cfgWith([{ ...wireEntry, apiKey: sealed }])
    const { apiKey: _dropped, ...withoutKey } = wireEntry
    const saved = await resolveCustomProvidersForSave(
      current,
      cfgWith([withoutKey as CustomProviderEntryWire]),
      secretBox,
    )
    expect(saved[0]?.apiKey).toBe(sealed)
  })

  test('rotating the key replaces the sealed value', async () => {
    const current = cfgWith([{ ...wireEntry, apiKey: secretBox.seal(PLAINTEXT) }])
    const saved = await resolveCustomProvidersForSave(
      current,
      cfgWith([{ ...wireEntry, apiKey: 'sk-rotated' }]),
      secretBox,
    )
    expect(secretBox.unseal(saved[0]!.apiKey!)).toBe('sk-rotated')
  })

  test('the mask can never become the credential', async () => {
    await expect(
      resolveCustomProvidersForSave(
        cfgWith([]),
        cfgWith([{ ...wireEntry, apiKey: CUSTOM_PROVIDER_API_KEY_MASK }]),
        secretBox,
      ),
    ).rejects.toThrow('config-custom-provider-apikey-required')
  })

  test('renaming an id requires the real key again', async () => {
    const current = cfgWith([{ ...wireEntry, apiKey: secretBox.seal(PLAINTEXT) }])
    await expect(
      resolveCustomProvidersForSave(
        current,
        cfgWith([{ ...wireEntry, id: 'renamed', apiKey: CUSTOM_PROVIDER_API_KEY_MASK }]),
        secretBox,
      ),
    ).rejects.toThrow('config-custom-provider-apikey-required')
  })

  test('rejects a reserved catalog id without consulting the runtime', async () => {
    let probed = false
    await expect(
      resolveCustomProvidersForSave(
        cfgWith([]),
        cfgWith([{ ...wireEntry, id: 'anthropic' }]),
        secretBox,
        {
          probeCatalogCollision: async () => {
            probed = true
            return false
          },
        },
      ),
    ).rejects.toThrow('config-custom-provider-id-reserved')
    expect(probed).toBe(false)
  })

  test('the canary probe catches a catalog id the static list does not know', async () => {
    // A newer OpenCode can add catalog providers; the static snapshot alone
    // would let one through and it would silently re-point that catalog.
    await expect(
      resolveCustomProvidersForSave(
        cfgWith([]),
        cfgWith([{ ...wireEntry, id: 'brandnew' }]),
        secretBox,
        {
          probeCatalogCollision: async (id) => id === 'brandnew',
        },
      ),
    ).rejects.toThrow('config-custom-provider-id-catalog')
  })

  test('the probe runs only for ids that are new to this config', async () => {
    const probedIds: string[] = []
    const current = cfgWith([{ ...wireEntry, apiKey: secretBox.seal(PLAINTEXT) }])
    // Disabling an existing entry must not depend on a working binary: an
    // operator whose runtime is broken still needs to turn a gateway off.
    await resolveCustomProvidersForSave(
      current,
      cfgWith([{ ...wireEntry, enabled: false, apiKey: CUSTOM_PROVIDER_API_KEY_MASK }]),
      secretBox,
      {
        probeCatalogCollision: async (id) => {
          probedIds.push(id)
          return false
        },
      },
    )
    expect(probedIds).toEqual([])
  })

  // Regression: the first implementation sealed anything that was not the mask,
  // so the stored (already sealed) value coming back around got sealed a second
  // time. Unsealing then yielded ciphertext, the gateway rejected every
  // request, and nothing in the platform pointed at the config write that did
  // it. Both layers of the fix are locked: the value-identity check here, and
  // the route's "only when the patch carries the key" gate.
  test('an already-sealed value passed back through is not sealed twice', async () => {
    const sealed = secretBox.seal(PLAINTEXT)
    const current = cfgWith([{ ...wireEntry, apiKey: sealed }])
    // Exactly what mergePatch produces for a PUT that never mentions providers.
    const saved = await resolveCustomProvidersForSave(current, current, secretBox)
    expect(saved[0]?.apiKey).toBe(sealed)
    expect(secretBox.unseal(saved[0]!.apiKey!)).toBe(PLAINTEXT)
  })

  test('validation issues surface with a stable code and the entry index', async () => {
    const attempt = resolveCustomProvidersForSave(
      cfgWith([]),
      cfgWith([wireEntry, { ...wireEntry, id: 'second', baseURL: 'https://gw/${HOME}' }]),
      secretBox,
    )
    await expect(attempt).rejects.toThrow('config-custom-provider-baseurl-invalid')
  })
})

describe('RFC-255 at rest', () => {
  test('the config file is written 0600 and carries no plaintext key', async () => {
    const path = await tempConfigPath()
    const saved = await resolveCustomProvidersForSave(cfgWith([]), cfgWith([wireEntry]), secretBox)
    saveConfigRaw(path, cfgWith(saved))
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    const onDisk = await readFile(path, 'utf-8')
    expect(onDisk).not.toContain(PLAINTEXT)
    expect(providersOf(loadConfig(path))[0]?.id).toBe('mygw')
  })

  test('an upgrade tightens a config that was written 0644 before', async () => {
    const path = await tempConfigPath()
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG), { mode: 0o644 })
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    saveConfigRaw(path, cfgWith([]))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

// The catalog probe, and the fact that production actually has one.
//
// Why this test exists: the first implementation shipped `probeCatalogCollision`
// as a type and a consumer with no production wiring, so the "two-layer" check
// the design promises was one layer — and the static layer listed 32 of the
// catalog's 170 ids. Names like `deepseek` or `siliconflow` would then save
// fine and fail every subsequent run with an unactionable `provider-untrusted`.
// The mock-injected test alone passed happily through all of that, so this file
// asserts the real wiring too.
describe('RFC-255 catalog collision probe', () => {
  test('an id that inherits catalog models is reported as a collision', async () => {
    const collided = await probeCatalogCollisionWith('deepseek', {
      enumerate: async () => ({
        binary: 'opencode',
        cached: false,
        // The injected canary PLUS models the platform never listed: the
        // signature of a config entry merging into a catalog provider.
        models: [
          { id: 'deepseek/__aw_catalog_canary__' },
          { id: 'deepseek/deepseek-chat' },
          { id: 'deepseek/deepseek-reasoner' },
        ],
      }),
    })
    expect(collided).toBe(true)
  })

  test('a genuinely new id reports only the canary', async () => {
    const collided = await probeCatalogCollisionWith('mygw', {
      enumerate: async () => ({
        binary: 'opencode',
        cached: false,
        models: [{ id: 'mygw/__aw_catalog_canary__' }, { id: 'opencode/grok-code' }],
      }),
    })
    expect(collided).toBe(false)
  })

  test('an unusable runtime does not block saving an ordinary gateway', async () => {
    // Fails open on purpose: the static snapshot already ran, and the launcher's
    // model-subset lock still refuses to RUN a collided provider. Blocking the
    // save would mean a broken binary stops all provider administration.
    const collided = await probeCatalogCollisionWith('mygw', {
      enumerate: async () => {
        throw new Error('binary missing')
      },
    })
    expect(collided).toBe(false)
  })

  test('the reserved snapshot covers the catalog ids most likely to be reused', () => {
    // Regression for the 32-of-170 gap: these are plausible private-relay names
    // that a first cut of the list accepted.
    for (const id of [
      'deepseek',
      'moonshotai',
      'zhipuai',
      'siliconflow',
      'minimax',
      'lmstudio',
      'fireworks-ai',
      'huggingface',
      'nebius',
      'baseten',
    ]) {
      expect(isReservedProviderId(id)).toBe(true)
    }
    expect(RESERVED_PROVIDER_IDS.length).toBeGreaterThan(150)
  })
})
