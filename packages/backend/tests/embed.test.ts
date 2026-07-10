import { rimrafDir } from './helpers/cleanup'
// P-5-05: embed runtime helpers — in dev mode the tables are empty stubs so
// the asset lookup returns null and the migrations extractor is a no-op. In
// the compiled binary (IS_EMBEDDED=true) `scripts/build-binary.ts` regenerates
// `embed.generated.ts` with real imports; that integration is covered by the
// build-binary CI job, not bun:test.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractMigrationsTo,
  getEmbeddedAsset,
  IS_EMBEDDED,
  listEmbeddedFrontendPaths,
} from '../src/embed'

describe('embed (dev stub)', () => {
  test('IS_EMBEDDED is false in dev', () => {
    expect(IS_EMBEDDED).toBe(false)
  })

  test('listEmbeddedFrontendPaths returns []', () => {
    expect(listEmbeddedFrontendPaths()).toEqual([])
  })

  test('getEmbeddedAsset returns null for any path in dev', async () => {
    expect(await getEmbeddedAsset('index.html')).toBeNull()
    expect(await getEmbeddedAsset('assets/anything.js')).toBeNull()
  })

  test('extractMigrationsTo writes 0 files and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-embed-test-'))
    try {
      expect(await extractMigrationsTo(join(dir, 'm1'))).toBe(0)
      expect(await extractMigrationsTo(join(dir, 'm1'))).toBe(0)
    } finally {
      rimrafDir(dir)
    }
  })
})
