// P-5-05: embed runtime helpers — in dev mode the tables are empty stubs so
// the asset lookup returns null and the migrations extractor is a no-op. In
// the compiled binary (IS_EMBEDDED=true) `scripts/build-binary.ts` regenerates
// `embed.generated.ts` with real imports; that integration is covered by the
// build-binary CI job, not bun:test.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractMigrationsTo,
  getEmbeddedAsset,
  getEmbeddedFrontendResponse,
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
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// P-5-05 regression lock (design/plan.md §P-5-05): an embedded release used to
// omit Cache-Control on every SPA response. Browsers could retain an old
// index.html and its old hashed bundle until users manually cleared the cache.
describe('embedded frontend HTTP cache policy', () => {
  const REVALIDATE = 'no-cache, must-revalidate'
  const IMMUTABLE = 'public, max-age=31536000, immutable'

  function asset(body: string, contentType: string): { body: ArrayBuffer; contentType: string } {
    return {
      body: new TextEncoder().encode(body).buffer as ArrayBuffer,
      contentType,
    }
  }

  function lookup(
    files: Readonly<Record<string, { body: ArrayBuffer; contentType: string }>>,
    seen: string[] = [],
  ) {
    return async (path: string) => {
      seen.push(path)
      return files[path] ?? null
    }
  }

  test('entry HTML and unhashed public files always revalidate', async () => {
    const files = {
      'index.html': asset('<main>new</main>', 'text/html; charset=utf-8'),
      'favicon.svg': asset('<svg/>', 'image/svg+xml'),
    }

    const index = await getEmbeddedFrontendResponse('/index.html', lookup(files))
    expect(index?.status).toBe(200)
    expect(index?.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(index?.headers.get('cache-control')).toBe(REVALIDATE)

    const favicon = await getEmbeddedFrontendResponse('/favicon.svg', lookup(files))
    expect(favicon?.status).toBe(200)
    expect(favicon?.headers.get('cache-control')).toBe(REVALIDATE)
  })

  test('client-side routes fall back to a revalidated index.html', async () => {
    const seen: string[] = []
    const response = await getEmbeddedFrontendResponse(
      '/tasks/01ABC',
      lookup(
        {
          'index.html': asset('<main>router</main>', 'text/html; charset=utf-8'),
        },
        seen,
      ),
    )

    expect(seen).toEqual(['tasks/01ABC', 'index.html'])
    expect(response?.headers.get('cache-control')).toBe(REVALIDATE)
    expect(await response?.text()).toBe('<main>router</main>')
  })

  test('content-hashed Vite assets are immutable for one year', async () => {
    const response = await getEmbeddedFrontendResponse(
      '/assets/index-B2dixesM.js',
      lookup({
        'assets/index-B2dixesM.js': asset('export {}', 'application/javascript; charset=utf-8'),
      }),
    )

    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(response?.headers.get('cache-control')).toBe(IMMUTABLE)
  })

  test('a missing old /assets URL returns no response instead of SPA HTML', async () => {
    const seen: string[] = []
    const response = await getEmbeddedFrontendResponse(
      '/assets/index-OLD.js',
      lookup(
        {
          'index.html': asset('<main>new</main>', 'text/html; charset=utf-8'),
        },
        seen,
      ),
    )

    expect(response).toBeNull()
    expect(seen).toEqual(['assets/index-OLD.js'])
  })
})
