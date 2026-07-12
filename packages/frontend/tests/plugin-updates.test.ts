// RFC-169 (T17) — locks the plugin update-cache fingerprint helpers: a cached
// check only counts for a plugin whose spec + resolvedVersion still match; a
// changed spec (re-install) drops the stale entry.

import { describe, expect, test } from 'vitest'
import {
  pluginUpdateAvailable,
  pluginUpdateMatches,
  pruneStalePluginUpdates,
  type PluginUpdatesCache,
} from '../src/lib/plugin-updates'

const plugin = { id: 'p1', spec: 'foo@^1', resolvedVersion: '1.2.0' }

describe('pluginUpdateMatches', () => {
  test('undefined entry never matches', () => {
    expect(pluginUpdateMatches(undefined, plugin)).toBe(false)
  })
  test('matches only when spec AND resolvedVersion are identical', () => {
    expect(
      pluginUpdateMatches({ spec: 'foo@^1', resolvedVersion: '1.2.0', latest: '1.3.0' }, plugin),
    ).toBe(true)
    expect(
      pluginUpdateMatches({ spec: 'foo@^2', resolvedVersion: '1.2.0', latest: '1.3.0' }, plugin),
    ).toBe(false)
    expect(
      pluginUpdateMatches({ spec: 'foo@^1', resolvedVersion: '1.1.0', latest: '1.3.0' }, plugin),
    ).toBe(false)
  })
})

describe('pluginUpdateAvailable', () => {
  test('true when a matching entry reports a newer latest', () => {
    expect(
      pluginUpdateAvailable({ spec: 'foo@^1', resolvedVersion: '1.2.0', latest: '1.3.0' }, plugin),
    ).toBe(true)
  })
  test('false when latest equals the installed version', () => {
    expect(
      pluginUpdateAvailable({ spec: 'foo@^1', resolvedVersion: '1.2.0', latest: '1.2.0' }, plugin),
    ).toBe(false)
  })
  test('false when latest is null', () => {
    expect(
      pluginUpdateAvailable({ spec: 'foo@^1', resolvedVersion: '1.2.0', latest: null }, plugin),
    ).toBe(false)
  })
  test('false when the fingerprint no longer matches (spec changed)', () => {
    expect(
      pluginUpdateAvailable({ spec: 'old@^1', resolvedVersion: '1.2.0', latest: '9.9.9' }, plugin),
    ).toBe(false)
  })
})

describe('pruneStalePluginUpdates', () => {
  test('keeps matching entries, drops fingerprint-mismatched and missing rows', () => {
    const cache: PluginUpdatesCache = {
      p1: { spec: 'foo@^1', resolvedVersion: '1.2.0', latest: '1.3.0' }, // still matches
      p2: { spec: 'bar@^1', resolvedVersion: '2.0.0', latest: '2.1.0' }, // spec changed below
      p3: { spec: 'gone', resolvedVersion: null, latest: '1.0.0' }, // row deleted
    }
    const rows = [
      { id: 'p1', spec: 'foo@^1', resolvedVersion: '1.2.0' },
      { id: 'p2', spec: 'bar@^2', resolvedVersion: '2.0.0' }, // spec moved
    ]
    expect(pruneStalePluginUpdates(cache, rows)).toEqual({
      p1: { spec: 'foo@^1', resolvedVersion: '1.2.0', latest: '1.3.0' },
    })
  })
  test('undefined cache → empty', () => {
    expect(pruneStalePluginUpdates(undefined, [])).toEqual({})
  })
})
