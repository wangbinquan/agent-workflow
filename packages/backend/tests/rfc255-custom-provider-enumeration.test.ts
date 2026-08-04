// RFC-255 T5 — custom gateway models reach the pickers, and the enumeration
// cache notices configuration changes.
//
// Why this test exists: enumeration runs the sealed binary with every config
// root redirected, so a custom provider only appears if the platform injects
// it explicitly. Two properties matter beyond "it shows up": the enumeration
// surface must stay credential-free (it runs with an empty auth store, so
// there is no reason for a key to be there), and the per-binary cache must key
// on the provider configuration — otherwise an administrator's edit keeps
// serving the previous model list until the daemon restarts.

import { describe, expect, test } from 'bun:test'
import {
  clearOpencodeModelsCache,
  evictOpencodeModelsCache,
  opencodeModelsCacheKey,
} from '@/util/opencode-models'
import { customProvidersProjection } from '@/services/runtime/opencode/customProvider'
import { listOpencodeModelsHermetic } from '@/services/runtime/opencode/models'
import { CUSTOM_PROVIDER_NPM, type CustomProviderEntryWire } from '@agent-workflow/shared'
import { mkdtemp, realpath, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry: CustomProviderEntryWire = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: 'https://gw.internal.example/v1',
  apiKey: 'sealed-value',
  models: [{ id: 'deepseek-v3' }, { id: 'qwen-max', name: 'Qwen Max' }],
  enabled: true,
}

/**
 * A stand-in for the byte-frozen snapshot that echoes the model ids it finds
 * in OPENCODE_CONFIG_CONTENT, in the `provider/model` shape the real binary
 * prints. Injected through the same seam the route uses.
 */
async function makeStubSnapshot(): Promise<{ snapshot: string; envDump: string }> {
  // macOS: /var is a symlink to /private/var, which the verified layout's
  // anti-symlink checks reject — canonicalize before use.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rfc255-models-')))
  const snapshot = join(root, 'opencode-stub')
  const envDump = join(root, 'env.json')
  // Written with grep/sed only: enumeration hard-codes PATH to /usr/bin:/bin,
  // so a stub reaching for node would fail exactly where a real fork would.
  await writeFile(
    snapshot,
    `#!/bin/sh
printf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(envDump)}
provider=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" |
  grep -oE '"provider":\\{"[a-z0-9._-]+"' | sed -E 's/.*"([a-z0-9._-]+)"$/\\1/')
[ -n "$provider" ] || exit 0
printf '%s' "$OPENCODE_CONFIG_CONTENT" |
  grep -oE '"[a-z0-9._-]+":\\{(\\}|"name")' |
  sed -E 's/^"([a-z0-9._-]+)".*/\\1/' |
  while read -r model; do
    printf '%s/%s\\n' "$provider" "$model"
  done
`,
    { mode: 0o755 },
  )
  await chmod(snapshot, 0o755)
  return { snapshot, envDump }
}

async function enumerate(
  entries: CustomProviderEntryWire[],
  binary = '/usr/local/bin/opencode',
): Promise<{ models: string[]; cached: boolean; configContent: string }> {
  const { snapshot, envDump } = await makeStubSnapshot()
  const result = await listOpencodeModelsHermetic(binary, {
    loadCustomProviderConfig: () => ({ customProviders: entries }),
    testOnlySnapshot: async (_command, run) => run(snapshot),
  })
  const configContent = await Bun.file(envDump)
    .text()
    .catch(() => '')
  return { models: result.models.map((m) => m.id), cached: result.cached, configContent }
}

describe('RFC-255 sealed enumeration', () => {
  test('lists a custom gateway model and never carries its credential', async () => {
    clearOpencodeModelsCache()
    const { models, configContent } = await enumerate([entry])
    expect(models).toContain('mygw/deepseek-v3')
    expect(models).toContain('mygw/qwen-max')
    // The enumeration runs against an empty auth store, so a key here would be
    // pure exposure with no function.
    expect(configContent).not.toContain('sealed-value')
    expect(configContent).not.toContain('apiKey')
    // Display names DO belong here — the picker renders them.
    expect(configContent).toContain('Qwen Max')
  })

  test('a disabled gateway disappears from the pickers', async () => {
    clearOpencodeModelsCache()
    const { models } = await enumerate([{ ...entry, enabled: false }])
    expect(models).toEqual([])
  })

  test('editing the model list invalidates the cached enumeration', async () => {
    clearOpencodeModelsCache()
    const first = await enumerate([entry])
    expect(first.cached).toBe(false)
    const again = await enumerate([entry])
    expect(again.cached).toBe(true)

    const edited = { ...entry, models: [{ id: 'deepseek-v3' }, { id: 'new-model' }] }
    const afterEdit = await enumerate([edited])
    expect(afterEdit.cached).toBe(false)
    expect(afterEdit.models).toContain('mygw/new-model')
  })

  test('rotating the key does NOT invalidate the enumeration', async () => {
    // The key is not part of what enumeration produces, so evicting on rotation
    // would only cost a spawn — and would imply the key is part of identity.
    clearOpencodeModelsCache()
    await enumerate([entry])
    const rotated = await enumerate([{ ...entry, apiKey: 'a-different-sealed-value' }])
    expect(rotated.cached).toBe(true)
  })
})

describe('RFC-255 cache key composition', () => {
  test('a binary with no custom providers keeps its original slot', () => {
    expect(opencodeModelsCacheKey('/bin/opencode')).toBe('/bin/opencode')
    expect(opencodeModelsCacheKey('/bin/opencode', '')).toBe('/bin/opencode')
    expect(customProvidersProjection({ customProviders: [] })).toBe('[]')
  })

  test('eviction drops every slot a binary accumulated, not just the exact key', async () => {
    // Runtime delete / binary change must not leave stale slots behind from
    // earlier provider configurations.
    clearOpencodeModelsCache()
    const binary = '/usr/local/bin/opencode-evict'
    await enumerate([entry], binary)
    await enumerate([{ ...entry, models: [{ id: 'only-one' }] }], binary)
    evictOpencodeModelsCache(binary)
    const afterEvict = await enumerate([entry], binary)
    expect(afterEvict.cached).toBe(false)
  })
})
