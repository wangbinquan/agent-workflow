// RFC-213 — shared tar.gz helpers.
//
// Extracted from services/backup.ts so backup (write), rawDbSnapshot (write)
// and restore (read) all go through ONE implementation instead of three
// hand-rolled `Bun.spawn(['tar', …])` calls that could drift. We shell out to
// the system `tar` (present on macOS + Linux, the only shipped targets).

/** Create `outPath` as a gzip'd tarball of everything under `srcDir`. `exclude`
 *  paths are relative to `srcDir` (e.g. `.git`) and passed to tar `--exclude`. */
export async function tarGz(
  srcDir: string,
  outPath: string,
  opts?: { exclude?: string[] },
): Promise<void> {
  const excludeArgs = (opts?.exclude ?? []).map((p) => `--exclude=./${p}`)
  const proc = Bun.spawn(['tar', '-czf', outPath, '-C', srcDir, ...excludeArgs, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`tar (create) exited with code ${exit}: ${stderr.trim()}`)
  }
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
