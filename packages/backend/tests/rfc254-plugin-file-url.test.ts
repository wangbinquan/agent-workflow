// RFC-254 T31 — a `file://` plugin install must convert the URL with
// `fileURLToPath`, never `new URL(spec).pathname`.
//
// `URL.pathname` is a URL COMPONENT, not a filesystem path. On POSIX the two
// coincide for `file:` URLs, so `installFilePlugin` looked correct everywhere
// the suite normally runs. On win32 `new URL('file:///C:/plugins/foo').pathname`
// is `/C:/plugins/foo` (leading slash), which `realpath` cannot open — so EVERY
// `file://` plugin install threw `PluginFileNotFoundError` on Windows. Measured
// on a Windows 11 ARM64 VM: `.pathname` → `/C:/plugins/foo`, `fileURLToPath` →
// `C:\plugins\foo`.
//
// The repo guard rfc254-file-url-pathname-guard only bans the `import.meta.url`
// spelling of this mistake, so the file-spec form here slipped through — hence
// this dedicated lock: a source anchor that runs on every POSIX leg, plus a
// behavioural install that RESOLVES rather than throws (the real regression is
// only observable on win32, but the assertion is valid on every platform).

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installPlugin } from '@/services/pluginInstaller'

describe('RFC-254 T31 — file:// plugin install path conversion', () => {
  test('source anchor: installFilePlugin uses fileURLToPath, never URL.pathname', () => {
    const text = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'pluginInstaller.ts'),
      'utf8',
    )
    expect(text).toContain('fileURLToPath(spec)')
    // Strip comments first — the fix's own comment DISCUSSES the banned form, so
    // a raw scan would match the explanation (see rfc254-git-windows for the
    // same technique).
    const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toContain('new URL(spec).pathname')
  })

  test('a file:// spec resolves to the host path (fails on win32 before the fix)', async () => {
    // `.native` because the GitHub windows tmpdir is an 8.3 short name and plain
    // realpathSync does not expand it (see rfc254-verified-plan-win32).
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'rfc254-plugin-fileurl-')))
    try {
      const file = join(dir, 'plugin.mjs')
      writeFileSync(file, 'export default {}\n')
      // pathToFileURL yields `file:///tmp/...` on POSIX and `file:///C:/...` on
      // win32 — exactly the shape a `sourceKind: 'file'` plugin spec carries.
      const spec = pathToFileURL(file).href
      const result = await installPlugin('plugin-1', spec)
      expect(result.sourceKind).toBe('file')
      // The whole point: it resolved to a REAL host path instead of throwing
      // PluginFileNotFoundError on the unopenable `/C:/...` string.
      expect(existsSync(result.cachedPath)).toBe(true)
      expect(result.cachedPath.endsWith('plugin.mjs')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
