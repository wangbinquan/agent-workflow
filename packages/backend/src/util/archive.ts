// RFC-213 — shared tar.gz helpers.
//
// Extracted from services/backup.ts so backup (write), rawDbSnapshot (write)
// and restore (read) all go through ONE implementation instead of three
// hand-rolled `Bun.spawn(['tar', …])` calls that could drift. We shell out to
// the system `tar`.
//
// RFC-254 T25b — Windows ships one too (bsdtar as `System32\\tar.exe`, since
// Windows 10 1803). The dialect question that would normally make that risky is
// already settled: macOS's `tar` IS bsdtar/libarchive, so every `--exclude=./x`
// and every exit-code path below is exercised against the same implementation
// on the existing macOS CI leg. What Windows adds is only the possibility that
// `tar` is missing entirely — hence the explicit presence check, which turns a
// bare ENOENT into something an operator can act on.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

/**
 * RFC-254 T25b: invoke tar by ABSOLUTE `System32\tar.exe` (bsdtar) on win32, not
 * a bare `tar`. A bare name resolves through PATH, and Git for Windows' GNU tar
 * comes first in many setups — GNU tar reads an absolute Windows path like
 * `C:\backups\x.tgz` as an rsh `host:path` and fails "Cannot connect to C:"
 * (measured on the real machine). Windows' own bsdtar handles drive-letter paths
 * and is the SAME libarchive dialect the macOS CI leg already exercises.
 */
export function tarBin(): string {
  if (process.platform === 'win32') {
    return join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    )
  }
  return 'tar'
}

/** Create `outPath` as a gzip'd tarball of everything under `srcDir`. `exclude`
 *  paths are relative to `srcDir` (e.g. `.git`) and passed to tar `--exclude`.
 *
 *  GNU tar (Linux) exits 1 with "file changed as we read it" when anything in
 *  `srcDir` moves while it reads — including SQLite finishing its -wal/-shm
 *  cleanup a beat after `close()` (bsdtar on macOS never reports this, which
 *  is why the race only reddened ubuntu CI shards, 2026-07-22 run
 *  29924465255). That is a TRANSIENT: one bounded retry over the now-quiescent
 *  directory yields a consistent archive, while a genuinely churning source
 *  still fails loud on the second attempt. We retry rather than tolerate the
 *  exit code — accepting it would let a torn file into a production backup. */
/**
 * Is a usable `tar` on PATH?
 *
 * Cached: backup runs hourly and restore is interactive, so re-probing per call
 * would be pure overhead, while a `tar` that appears mid-process is not a case
 * worth chasing.
 */
let tarProbe: boolean | undefined
export function tarAvailable(): boolean {
  tarProbe ??= process.platform === 'win32' ? existsSync(tarBin()) : Bun.which('tar') !== null
  return tarProbe
}

export function resetTarProbeForTests(): void {
  tarProbe = undefined
}

function assertTar(): void {
  if (tarAvailable()) return
  throw new Error(
    'tar is not available on PATH. Backup and restore need it; on Windows it ships ' +
      'as %SystemRoot%\\System32\\tar.exe (Windows 10 1803+), on Linux install the ' +
      "distribution's tar package.",
  )
}

export async function tarGz(
  srcDir: string,
  outPath: string,
  opts?: { exclude?: string[] },
): Promise<void> {
  assertTar()
  const excludeArgs = (opts?.exclude ?? []).map((p) => `--exclude=./${p}`)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn([tarBin(), '-czf', outPath, '-C', srcDir, ...excludeArgs, '.'], {
      ...platformSpawnOptionsForHost(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exit = await proc.exited
    if (exit === 0) return
    const stderr = (await new Response(proc.stderr).text()).trim()
    lastError = `tar (create) exited with code ${exit}: ${stderr}`
    const transientChange = exit === 1 && /file changed as we read it/.test(stderr)
    if (!transientChange) break
  }
  throw new Error(lastError)
}

/** Extract `tarPath` into `destDir` (which must already exist). */
export async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  assertTar()
  const proc = Bun.spawn([tarBin(), '-xzf', tarPath, '-C', destDir], {
    ...platformSpawnOptionsForHost(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`tar (extract) exited with code ${exit}: ${stderr.trim()}`)
  }
}
