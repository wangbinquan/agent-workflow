// Regression: every Bun.spawn that launches opencode must set `PWD = cwd` in
// the child env. opencode 1.14.51+ (upstream commit 7f2b5ee8c, the Effect-TS
// rewrite of `packages/opencode/src/cli/cmd/run.ts`) resolves its root via
// `process.env.PWD ?? process.cwd()` — not just `process.cwd()`. Bun.spawn's
// `cwd:` option updates `process.cwd()` but inherits `PWD` from the daemon's
// parent shell. If we don't override PWD, opencode treats the daemon's launch
// directory (often the repo source root) as the project root, loads TWO
// Instances (one at the spawn cwd via effectCmd preload, one at PWD as the
// SDK default), the session lands in the wrong one, and `--format json`
// events stop reaching the runner's stdout pump entirely. Every node then
// fails "no <workflow-output> envelope found in stdout" with exit 0, and
// SessionTab renders empty because node_run_events has no parseable rows.
//
// Hands-on reproduction (2026-05-20): with opencode-ai 1.14.51 globally
// installed and PWD differing from cwd, `opencode run ... --format json
// --thinking --dangerously-skip-permissions </dev/null > out.txt` emitted
// ONLY the toolkit plugin's `console.log` lines, ZERO JSON events. Setting
// PWD = cwd restored the expected 3-event stream byte-identically.
//
// This test source-greps every opencode spawn site to lock the contract.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SPAWN_SITES = [
  // (file, identifier the spawn cwd is read from)
  ['src/services/runner.ts', 'opts.worktreePath'],
  ['src/services/memoryDistiller.ts', 'input.cwd'],
] as const

describe('opencode spawn sites set PWD = cwd in env', () => {
  for (const [rel, cwdExpr] of SPAWN_SITES) {
    test(`${rel} sets PWD: ${cwdExpr} in the spawn env`, () => {
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf-8')

      // The env literal lives just above the Bun.spawn(...) call. Both files
      // build a `const env: Record<string, string> = { ... }` block then pass
      // it into `Bun.spawn({ cmd, cwd, env, ... })`. Assert that block carries
      // the PWD override pointing at the same expression as `cwd`.
      const envBlockRe = /const env: Record<string, string> = \{([\s\S]*?)\n\s*\}/g
      const matches: string[] = []
      let m: RegExpExecArray | null
      while ((m = envBlockRe.exec(src)) !== null) matches.push(m[1]!)
      expect(matches.length).toBeGreaterThan(0)
      const found = matches.some(
        (block) =>
          block.includes(`PWD: ${cwdExpr}`) &&
          block.includes('...(process.env as Record<string, string>)'),
      )
      expect(found).toBe(true)
    })

    test(`${rel} passes the same identifier to both cwd: and PWD:`, () => {
      // Why: a future refactor that changes the spawn cwd (say to
      // `runDir` or `repoPath`) but forgets to update PWD would silently
      // reintroduce the 1.14.51 stdout break. This grep keeps the two in
      // lock-step at the source level.
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf-8')
      const spawnBlockRe = /Bun\.spawn\(\{([\s\S]*?)\n\s*\}\)/g
      let m: RegExpExecArray | null
      let asserted = false
      while ((m = spawnBlockRe.exec(src)) !== null) {
        const block = m[1]!
        // Only enforce on the opencode spawn (skips git / tar / etc. blocks
        // in other files; both opencode sites pass `cwd:` followed by the
        // tracked expression).
        if (!block.includes(`cwd: ${cwdExpr}`)) continue
        // The env passed in must carry PWD = cwdExpr. Earlier test already
        // checked the env-block content; this one just confirms the spawn
        // block references the same cwd identifier we expect.
        expect(block).toContain('env,')
        asserted = true
      }
      expect(asserted).toBe(true)
    })
  }
})
