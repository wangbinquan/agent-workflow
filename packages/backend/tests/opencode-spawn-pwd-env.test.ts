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

// RFC-111 PR-A: the opencode spawn ENV literal (the `const env = {...}` block
// carrying `PWD = cwd`) moved out of runner.ts into the runtime driver
// (runtime/opencode/spawn.ts, `PWD: ctx.worktreePath`). runner.ts still owns the
// `Bun.spawn({ cwd, env })` call.
// RFC-117: memoryDistiller.ts no longer assembles its own env block — it routes
// through the runtime driver's buildSpawn, so PWD is set by buildOpencodeEnv
// (locked by the driver site below). RFC-224 gives the system invocation its
// own worktree subdirectory. The distiller's PWD=cwd contract now holds via
// (a) buildSpawn({ worktreePath: worktreeDir }) and (b) Bun.spawn({
// cwd: worktreeDir, env: plan.env }) — asserted separately below.
const ENV_PWD_SITES = [
  // (file, identifier PWD is set from in the env block)
  ['src/services/runtime/opencode/spawn.ts', 'ctx.worktreePath'],
] as const
const SPAWN_CWD_SITES = [
  // (file, identifier the Bun.spawn cwd is read from, env expression)
  ['src/services/runner.ts', 'opts.worktreePath', 'env'],
  ['src/services/memoryDistiller.ts', 'worktreeDir', 'plan.env'],
] as const

describe('opencode spawn sites set PWD = cwd in env', () => {
  for (const [rel, cwdExpr] of ENV_PWD_SITES) {
    test(`${rel} sets PWD: ${cwdExpr} in the spawn env block`, () => {
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf-8')

      // The env literal is a `const env: Record<string, string> = { ... }`
      // block. Assert it carries the PWD override pointing at the same
      // expression the Bun.spawn cwd will use, plus the process.env baseline.
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
  }

  // RFC-117/RFC-224: the distiller routes through the runtime plan instead of an
  // inline env block. Its isolated worktreeDir is the single cwd handed to both
  // plan construction and Bun.spawn, so buildOpencodeEnv sets the same PWD.
  test('memoryDistiller.ts passes its isolated worktreeDir into buildSpawn', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src/services/memoryDistiller.ts'),
      'utf-8',
    )
    expect(src).toContain('buildSpawn(')
    expect(src).toContain("const worktreeDir = join(input.cwd, 'worktree')")
    expect(src).toContain('worktreePath: worktreeDir')
  })

  for (const [rel, cwdExpr, envExpr] of SPAWN_CWD_SITES) {
    test(`${rel} passes cwd: ${cwdExpr} + ${envExpr} into Bun.spawn`, () => {
      // Why: a future refactor that changes the spawn cwd (say to
      // `runDir` or `repoPath`) but forgets to update PWD would silently
      // reintroduce the 1.14.51 stdout break. This grep keeps the Bun.spawn
      // cwd and the passed-in env in lock-step at the source level.
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf-8')
      const spawnBlockRe = /Bun\.spawn\(\{([\s\S]*?)\n\s*\}\)/g
      let m: RegExpExecArray | null
      let asserted = false
      while ((m = spawnBlockRe.exec(src)) !== null) {
        const block = m[1]!
        // Only enforce on the opencode spawn (skips git / tar / etc. blocks).
        if (!block.includes(`cwd: ${cwdExpr}`)) continue
        expect(block).toContain(envExpr === 'env' ? 'env,' : `env: ${envExpr}`)
        asserted = true
      }
      expect(asserted).toBe(true)
    })
  }
})
