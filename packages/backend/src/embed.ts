// P-5-05 single-binary runtime helpers.
//
// `embed.generated.ts` lists every file the build script chose to embed; this
// module hides the storage detail behind two operations the daemon uses:
//   - `getEmbeddedAsset(urlPath)` — synchronous-ish lookup for static GETs
//     when the daemon serves the SPA from the binary instead of a vite dev
//     server.
//   - `extractMigrationsTo(dir)` — drizzle's bun-sqlite migrator wants a
//     filesystem path. In dev that path is packages/backend/db/migrations on
//     disk; in the binary we extract the embedded copies once on startup.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FRONTEND_FILES, IS_EMBEDDED, MIGRATION_FILES } from './embed.generated'

export { IS_EMBEDDED }

export function listEmbeddedFrontendPaths(): string[] {
  return Object.keys(FRONTEND_FILES)
}

/**
 * Count the .sql files embedded in the binary. `doctor` uses this when
 * IS_EMBEDDED=true to check that the binary actually carries migrations,
 * since the on-disk `Paths.migrationsDir` is meaningless in that mode
 * (`import.meta.dirname` gets baked into `/` by `bun build --compile`).
 *
 * Mirror filtering used by `start.ts`'s dbVersion calculation (.sql only —
 * `meta/_journal.json` is metadata, not a migration).
 */
export function countEmbeddedSqlMigrations(): number {
  let count = 0
  for (const rel of Object.keys(MIGRATION_FILES)) {
    if (rel.endsWith('.sql')) count++
  }
  return count
}

export interface EmbeddedAsset {
  body: ArrayBuffer
  contentType: string
}

export type EmbeddedAssetLookup = (urlPath: string) => Promise<EmbeddedAsset | null>

export async function getEmbeddedAsset(urlPath: string): Promise<EmbeddedAsset | null> {
  const filePath = FRONTEND_FILES[urlPath]
  if (filePath === undefined) return null
  const body = await Bun.file(filePath).arrayBuffer()
  return { body, contentType: mimeTypeFor(urlPath) }
}

const REVALIDATE_CACHE_CONTROL = 'no-cache, must-revalidate'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Resolve one embedded-frontend request and apply the cache policy at the
 * response boundary:
 *   - Vite's /assets/* files are content-hashed, so they can be immutable.
 *   - index.html, SPA fallbacks, and unhashed public files must revalidate.
 *   - a missing /assets/* path is not an SPA route. Returning null lets the
 *     caller send a real 404 instead of serving HTML to a module request.
 *
 * The lookup seam keeps the compiled-only asset table behavior-testable while
 * the committed development stub remains empty.
 */
export async function getEmbeddedFrontendResponse(
  requestPath: string,
  lookup: EmbeddedAssetLookup = getEmbeddedAsset,
): Promise<Response | null> {
  const directPath = stripLeadingSlash(requestPath)
  const direct = await lookup(directPath)
  if (direct !== null) return embeddedAssetResponse(direct, directPath)

  if (isViteAssetPath(directPath)) return null

  const indexHtml = await lookup('index.html')
  if (indexHtml === null) return null
  return embeddedAssetResponse(indexHtml, 'index.html')
}

/**
 * Write every embedded migration file (and meta/_journal.json) into
 * `targetDir`, mirroring the original folder layout so drizzle's migrator
 * can `readFileSync` them. Returns the count of files written.
 */
export async function extractMigrationsTo(targetDir: string): Promise<number> {
  return extractFilesTo(targetDir, MIGRATION_FILES)
}

/**
 * The body of {@link extractMigrationsTo}, parameterised over the file map so
 * it is testable: `MIGRATION_FILES` is empty outside the compiled binary, so
 * the real extraction path is unreachable from unit tests and this cost stayed
 * invisible until it broke CI.
 *
 * **Shape is load-bearing, do not "simplify" back into a sequential loop.**
 * This used to be one `mkdirSync` + one read + one sync write *per file*,
 * strictly sequential. Every e2e test mkdtemps a fresh home, so each of them
 * re-extracts the full set; on the Windows runner each write is scanned by the
 * AV filter, so 171 files cost ~23.5s and blew the harness's 30s
 * daemon-ready budget — five specs failed with a single shared root cause
 * (CI run 31802101748, `Playwright e2e (shard 2/4)` on windows-latest). The
 * cost also grows with every migration added, so it was a worsening latent
 * failure rather than a one-off.
 *
 * Two changes: the distinct destination dirs are created once up front instead
 * of once per file, and the copies run with bounded concurrency so the
 * per-file latency overlaps instead of summing.
 */
export async function extractFilesTo(
  targetDir: string,
  files: Readonly<Record<string, string>>,
): Promise<number> {
  mkdirSync(targetDir, { recursive: true })
  const entries = Object.entries(files)
  if (entries.length === 0) return 0

  const dirs = new Set<string>()
  for (const [rel] of entries) dirs.add(dirname(join(targetDir, rel)))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })

  // Bounded rather than unbounded: 171 concurrent writes would trade the
  // sequential stall for a file-descriptor spike on the same runners.
  const concurrency = Math.min(16, entries.length)
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++
        if (index >= entries.length) return
        const entry = entries[index]
        if (entry === undefined) return
        const [rel, src] = entry
        await Bun.write(join(targetDir, rel), Bun.file(src))
      }
    }),
  )
  return entries.length
}

function embeddedAssetResponse(asset: EmbeddedAsset, assetPath: string): Response {
  return new Response(asset.body, {
    headers: {
      'content-type': asset.contentType,
      'cache-control': isViteAssetPath(assetPath)
        ? IMMUTABLE_CACHE_CONTROL
        : REVALIDATE_CACHE_CONTROL,
    },
  })
}

function isViteAssetPath(path: string): boolean {
  return path === 'assets' || path.startsWith('assets/')
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

function mimeTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8'
    case 'js':
    case 'mjs':
      return 'application/javascript; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'ico':
      return 'image/x-icon'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    case 'map':
      return 'application/json; charset=utf-8'
    case 'txt':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
