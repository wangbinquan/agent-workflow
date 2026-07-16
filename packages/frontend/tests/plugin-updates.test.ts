// RFC-201 — update receipts are keyed by stable id + exact config hash.

import { describe, expect, test } from 'vitest'
import {
  pluginUpdateAvailable,
  pluginUpdateCacheKey,
  pluginUpdateEntry,
  pluginUpdateMatches,
  pruneStalePluginUpdates,
  type PluginUpdateEntry,
  type PluginUpdatesCache,
} from '../src/lib/plugin-updates'

const plugin = { id: 'p1', operationConfigHash: 'hash-1' }
const ready: PluginUpdateEntry = {
  configHashUsed: 'hash-1',
  available: true,
  latest: '1.3.0',
  identityStatus: 'known',
}

describe('Plugin exact-hash update cache', () => {
  test('composite key separates receipts for successive saved revisions', () => {
    expect(pluginUpdateCacheKey('p1', 'h1')).toBe('p1:h1')
    expect(pluginUpdateCacheKey('p1', 'h2')).not.toBe(pluginUpdateCacheKey('p1', 'h1'))
  })

  test('match and available require the exact hash and known identity', () => {
    expect(pluginUpdateMatches(undefined, plugin)).toBe(false)
    expect(pluginUpdateMatches(ready, plugin)).toBe(true)
    expect(pluginUpdateAvailable(ready, plugin)).toBe(true)
    expect(pluginUpdateAvailable({ ...ready, configHashUsed: 'old' }, plugin)).toBe(false)
    expect(pluginUpdateAvailable({ ...ready, available: false }, plugin)).toBe(false)
    expect(pluginUpdateAvailable({ ...ready, identityStatus: 'unknown' }, plugin)).toBe(false)
  })

  test('lookup and prune preserve only current id+hash receipts', () => {
    const cache: PluginUpdatesCache = {
      'p1:hash-1': ready,
      'p1:old': { ...ready, configHashUsed: 'old' },
      'p2:gone': { ...ready, configHashUsed: 'gone' },
    }
    expect(pluginUpdateEntry(cache, plugin)).toEqual(ready)
    expect(pruneStalePluginUpdates(cache, [plugin])).toEqual({ 'p1:hash-1': ready })
    expect(pruneStalePluginUpdates(undefined, [])).toEqual({})
  })
})
