// P-5-05: embed runtime helpers — in dev mode the tables are empty stubs so
// the asset lookup returns null and the migrations extractor is a no-op. In
// the compiled binary (IS_EMBEDDED=true) `scripts/build-binary.ts` regenerates
// `embed.generated.ts` with real imports; that integration is covered by the
// build-binary CI job, not bun:test.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractFilesTo,
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

// Why this block exists: `MIGRATION_FILES` is empty outside the compiled
// binary, so the test above exercises nothing but the empty-map early return —
// the real extraction path had no unit coverage at all. That blind spot is how
// a ~23.5s Windows extraction (171 files, one mkdir + one sequential write
// each) stayed invisible until it blew the e2e harness's 30s daemon-ready
// budget and failed five specs at once (CI run 31802101748). `extractFilesTo`
// is the same body parameterised over the file map so it can be driven here.
describe('extractFilesTo (the real extraction path)', () => {
  test('writes every file, creates nested dirs, and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-extract-test-'))
    try {
      const srcDir = join(root, 'src')
      mkdirSync(join(srcDir, 'meta'), { recursive: true })
      // Enough files to actually go around the bounded-concurrency pool
      // (16) more than once, and a nested dir so the "pre-create the distinct
      // dirs once" path is covered rather than the flat happy case.
      const files: Record<string, string> = {}
      const expected = new Map<string, string>()
      for (let i = 0; i < 40; i++) {
        const rel = `${String(i).padStart(4, '0')}_migration.sql`
        const body = `-- migration ${i}\nCREATE TABLE t${i} (id TEXT PRIMARY KEY);\n`
        writeFileSync(join(srcDir, rel), body)
        files[rel] = join(srcDir, rel)
        expected.set(rel, body)
      }
      const journalRel = join('meta', '_journal.json')
      const journalBody = JSON.stringify({ version: '7', entries: [] })
      writeFileSync(join(srcDir, journalRel), journalBody)
      files[journalRel] = join(srcDir, journalRel)
      expected.set(journalRel, journalBody)

      const target = join(root, 'out')
      expect(await extractFilesTo(target, files)).toBe(41)
      for (const [rel, body] of expected) {
        expect(readFileSync(join(target, rel), 'utf-8')).toBe(body)
      }

      // Re-extracting over an existing dir must not throw or lose content —
      // `restore.ts` and a same-home daemon restart both hit this path.
      expect(await extractFilesTo(target, files)).toBe(41)
      expect(readFileSync(join(target, journalRel), 'utf-8')).toBe(journalBody)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an empty map still creates the target dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-extract-empty-'))
    try {
      const target = join(root, 'out')
      expect(await extractFilesTo(target, {})).toBe(0)
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
