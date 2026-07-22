// RFC-213 — shared tar.gz helpers.
//
// Extracted from services/backup.ts so backup (write), rawDbSnapshot (write)
// and restore (read) all go through ONE implementation instead of three
// hand-rolled `Bun.spawn(['tar', …])` calls that could drift. We shell out to
// the system `tar` (present on macOS + Linux, the only shipped targets).

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
export async function tarGz(
  srcDir: string,
  outPath: string,
  opts?: { exclude?: string[] },
): Promise<void> {
  const excludeArgs = (opts?.exclude ?? []).map((p) => `--exclude=./${p}`)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn(['tar', '-czf', outPath, '-C', srcDir, ...excludeArgs, '.'], {
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
  const proc = Bun.spawn(['tar', '-xzf', tarPath, '-C', destDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`tar (extract) exited with code ${exit}: ${stderr.trim()}`)
  }
}
