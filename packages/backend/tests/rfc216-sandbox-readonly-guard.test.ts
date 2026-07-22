// RFC-216 §6 — the STATIC half of the read-only guarantee. The sandbox preflight
// must never execute a package manager / sysctl / shell, and never write a file.
// A subprocess sentinel test proves the behavior; this locks the source-level
// contract so a "print → execute" or "readConfig → loadConfig" regression is
// caught even before it can run.
//
// We strip comments first: the files DESCRIBE these forbidden APIs in prose
// (e.g. "uses no Bun.$/execSync"), and a naive grep would false-positive on the
// documentation (the classic comment-literal guard trip).

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')

/** Remove block + line comments so guards fire on CODE, not documentation. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const FORBIDDEN_EXEC = [
  /from ['"]node:child_process['"]/,
  /\bBun\.\$/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
]
const FORBIDDEN_WRITE = [
  /\bwriteFileSync\b/,
  /\bwriteFile\b/,
  /\bmkdirSync\b/,
  /\bmkdir\b/,
  /\brmSync\b/,
  /\brenameSync\b/,
  /\bappendFileSync\b/,
]

describe('guidance.ts is a pure leaf — no effects at all', () => {
  const code = stripComments(read('services/sandbox/guidance.ts'))
  it('imports no node:child_process and never spawns / whichs', () => {
    for (const re of [...FORBIDDEN_EXEC, /\bBun\.spawn\b/, /\bBun\.which\b/]) {
      expect(code).not.toMatch(re)
    }
  })
  it('writes no files', () => {
    for (const re of FORBIDDEN_WRITE) expect(code).not.toMatch(re)
  })
})

describe('cli/sandbox.ts — the only spawn is the probe; no exec/write escapes', () => {
  const code = stripComments(read('cli/sandbox.ts'))
  it('imports no node:child_process, uses no Bun.$/execSync/spawnSync', () => {
    for (const re of FORBIDDEN_EXEC) expect(code).not.toMatch(re)
  })
  it('writes no files', () => {
    for (const re of FORBIDDEN_WRITE) expect(code).not.toMatch(re)
  })
  it('Bun.spawn appears EXACTLY once (in boundedSpawn), so nothing else can execute', () => {
    const hits = code.match(/\bBun\.spawn\b/g) ?? []
    expect(hits.length).toBe(1)
  })
})
