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
import {
  CUSTOM_PROVIDER_API_KEY_MASK,
  CUSTOM_PROVIDER_NPM,
  DEFAULT_CONFIG,
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

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rfc255-config-'))
  return join(dir, 'config.json')
}

describe('RFC-255 masking', () => {
  test('replaces every stored credential on the way out', () => {
    const sealed = secretBox.seal(PLAINTEXT)
    const masked = maskConfigForOutput(cfgWith([{ ...wireEntry, apiKey: sealed }]))
    expect(masked.customProviders[0]?.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)
    expect(JSON.stringify(masked)).not.toContain(sealed)
    expect(JSON.stringify(masked)).not.toContain(PLAINTEXT)
    // Everything else is untouched — the UI needs it to render the row.
    expect(masked.customProviders[0]?.baseURL).toBe(wireEntry.baseURL)
    expect(masked.customProviders[0]?.name).toBe('Internal Gateway')
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
    const submitted = cfgWith([
      { ...echoed.customProviders[0]!, baseURL: 'https://gw.internal.example/v2' },
    ])
    const saved = await resolveCustomProvidersForSave(current, submitted, secretBox)
    expect(saved[0]?.apiKey).toBe(sealed)
    expect(secretBox.unseal(saved[0]!.apiKey!)).toBe(PLAINTEXT)
    expect(saved[0]?.baseURL).toBe('https://gw.internal.example/v2')
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
    expect(loadConfig(path).customProviders[0]?.id).toBe('mygw')
  })

  test('an upgrade tightens a config that was written 0644 before', async () => {
    const path = await tempConfigPath()
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG), { mode: 0o644 })
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    saveConfigRaw(path, cfgWith([]))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
