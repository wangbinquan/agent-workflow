// RFC-254 T32 — the shared "v1 then v2" stub-opencode, as a COMMAND ARRAY.
//
// Six review-family suites each carried their own `#!/usr/bin/env bash`
// stub-opencode with the same shape: `--version` answers a fixed banner; `run`
// recovers the nonce from argv, bumps an invoke counter, and emits a
// workflow-output envelope whose port body is V1 on the first call and V2
// afterwards (some variants also write the body into the task worktree and
// emit the RELATIVE PATH instead — the markdown_file contract). A bash file is
// not executable on Windows (spawn EFTYPE), so on that platform every flow
// test in those suites died with "review node_run not created by scheduler" —
// a message that points at the scheduler and means only "no interpreter".
//
// The fix is the fusion-engine seam-change: `opencodeCmd` is already an argv
// array that goes straight to spawn, so hand over `[bun, script.ts]` — no fake
// binary, no shell, no platform branch, and the stub logic is type-checked
// with the suite. The nonce HAS to be parsed out of argv, which is exactly why
// a `.cmd` shim cannot stand in (measured: cmd.exe truncates the prompt at its
// first newline and drops everything after it).
//
// Kept as ONE fixture rather than six inline copies for the usual reason:
// the next portability fix lands in one place. Suites remain independently
// runnable — they only share the constructor.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface VersionedStubOptions {
  /** Body emitted on the first `run` invocation. */
  v1: string
  /** Body emitted on every later invocation. Defaults to v1 (single-version). */
  v2?: string
  /** Envelope port name. Defaults to 'design'. */
  port?: string
  /**
   * When set, the body is WRITTEN to this worktree-relative path (under the
   * child's cwd) and the envelope carries the relative path instead of the
   * body — the `markdown_file` output-kind contract.
   */
  fileRelPath?: string
}

/**
 * Write the stub script into `dir` and return the command array to pass as
 * `opencodeCmd`. Each call also (re)creates the invoke counter at
 * `<dir>/.invoke-counter`, so a fresh harness always starts at v1.
 */
export function makeVersionedStubOpencode(dir: string, opts: VersionedStubOptions): string[] {
  const path = join(dir, 'stub-opencode.ts')
  const counterFile = join(dir, '.invoke-counter')
  writeFileSync(counterFile, '0')
  const port = opts.port ?? 'design'
  const fileClause =
    opts.fileRelPath === undefined
      ? `  const payload = body`
      : `  const sourcePath = join(process.cwd(), ${JSON.stringify(opts.fileRelPath)})
  mkdirSync(dirname(sourcePath), { recursive: true })
  writeFileSync(sourcePath, body)
  const payload = ${JSON.stringify(opts.fileRelPath)}`
  const script = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const argv = Bun.argv.slice(2)
if (argv[0] === '--version') {
  console.log('stub-opencode 1.14.99')
  process.exit(0)
}
if (argv[0] === 'run') {
  const nonce = /nonce="([^"]*)"/.exec(argv.join('\\n'))?.[1] ?? ''
  const open = nonce.length > 0 ? \`<workflow-output nonce="\${nonce}">\` : '<workflow-output>'
  const counterFile = ${JSON.stringify(counterFile)}
  const n = Number(readFileSync(counterFile, 'utf8').trim()) + 1
  writeFileSync(counterFile, String(n))
  const body = n === 1 ? ${JSON.stringify(opts.v1)} : ${JSON.stringify(opts.v2 ?? opts.v1)}
${fileClause}
  const text = \`\${open}<port name=${JSON.stringify(port)}>\${payload}</port></workflow-output>\`
  console.log(JSON.stringify({ type: 'text', ts: Math.floor(Date.now() / 1000), text }))
  process.exit(0)
}
console.log(\`unknown subcommand \${argv[0]}\`)
process.exit(1)
`
  writeFileSync(path, script)
  return [process.execPath, path]
}
