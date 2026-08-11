// RFC-029: opencode plugin module — entry points used by the framework.
//
// `transcoder.ts` exposes the TS twin of `aw-inventory-dump.mjs`'s pure
// conversion functions so that unit tests can exercise the field mapping
// without spawning an opencode process.
//
// `materializeInventoryPlugin(runRoot)` copies the dump plugin's .mjs into
// the per-run dir so opencode can load it via inline
// `OPENCODE_CONFIG_CONTENT.plugin` `file://` URL. Two routes:
//   - dev mode: read from the source tree adjacent to this file,
//   - binary mode (built by scripts/build-binary.ts): fall back to the
//     embedded `/$bunfs/...` path looked up in `embed.generated.PLUGIN_FILES`.
// The CI failure that motivated this fallback: the e2e Playwright suite
// runs against the compiled binary which previously had no .mjs on disk →
// copyFileSync ENOENT → no OPENCODE_AW_INVENTORY_OUT set → stub couldn't
// write inventory → captured:false → no chips → e2e red.

import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_FILES } from '../embed.generated'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_BASENAME = 'aw-inventory-dump.mjs'

/**
 * Absolute path to the dump plugin's ESM source as seen by the *current*
 * runtime. In dev this is the source tree; in single-binary mode it's a
 * `/$bunfs/...` path. Falls back to the dev path even when neither exists
 * so callers that only care about logging get a stable string.
 */
export function awInventoryDumpSourcePath(): string {
  const devPath = resolve(HERE, PLUGIN_BASENAME)
  if (existsSync(devPath)) return devPath
  const embedded = PLUGIN_FILES[PLUGIN_BASENAME]
  if (embedded !== undefined && existsSync(embedded)) return embedded
  return devPath
}

/**
 * Copy `aw-inventory-dump.mjs` into `runRoot` so opencode's plugin loader
 * can `import()` it via the inline `file://` URL the runner adds to
 * OPENCODE_CONFIG_CONTENT.plugin. Returns the absolute path the runner
 * should reference. Throws if neither dev nor embedded source is reachable
 * so the runner's outer try/catch can degrade cleanly to
 * `plugin-load-failed`.
 *
 * Dev mode: `copyFileSync` from the source tree path.
 *
 * Binary mode: the embed table value is a `/$bunfs/...` path Bun materializes
 * from a `with { type: 'file' }` import. `copyFileSync` on those bunfs paths
 * is unreliable (CI run 25993404058 / e2e RFC-029 surfaced this — copy
 * silently dropped the file so the plugin never wrote inventory.json). The
 * working pattern (also used by `extractMigrationsTo` in `embed.ts`) is to
 * read the bytes via `Bun.file(...).arrayBuffer()` and `writeFileSync` them
 * out — hence the async signature. Synchronously checking `existsSync` on
 * the bunfs path also returns false in 1.3.x, so we use the embed table
 * presence as the gating signal instead of `existsSync`.
 */
export async function materializeInventoryPlugin(runRoot: string): Promise<string> {
  const target = join(runRoot, PLUGIN_BASENAME)
  const devPath = resolve(HERE, PLUGIN_BASENAME)
  if (existsSync(devPath)) {
    copyFileSync(devPath, target)
    return target
  }
  const embedded = PLUGIN_FILES[PLUGIN_BASENAME]
  if (embedded !== undefined) {
    const bytes = new Uint8Array(await Bun.file(embedded).arrayBuffer())
    writeFileSync(target, bytes)
    return target
  }
  throw new Error(
    `aw-inventory-dump.mjs not found in dev tree (${devPath}) or embed table (PLUGIN_FILES['${PLUGIN_BASENAME}'])`,
  )
}

export * from './transcoder'
