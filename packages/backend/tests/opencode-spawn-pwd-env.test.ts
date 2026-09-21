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
  // RFC-280 T7: the runner no longer Bun.spawns — every agent child (business /
  // system / smoke / distiller / playground) goes through the unified
  // executor, whose managedProcess core is the ONE spawn site keeping cwd/env
  // in lock-step. The runner's own PWD contract is verified below (it passes
  // opts.worktreePath + the driver env straight into runAgentProcess).
  ['src/services/execution/managedProcess.ts', 'req.cwd', 'req.env'],
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
  test('runner.ts hands opts.worktreePath + the driver env straight to the executor', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src/services/runner.ts'), 'utf-8')
    // RFC-280 T7: no direct Bun.spawn; the child runs through runAgentProcess
    // with cwd = the task worktree and env = the driver-assembled plan env.
    expect(src).toContain('await runAgentProcess({')
    expect(src).toContain('cwd: opts.worktreePath,')
    expect(src).toContain('env,')
    expect(src).not.toContain('Bun.spawn(')
  })

  // RFC-367: the distiller stopped assembling its own spawn. It hands a scratch
  // name to `runSystemAgent`, which owns the worktreeDir → buildSpawn → executor
  // chain (the same one intent / change-narrative / the MCP playground use). So
  // the distiller's PWD contract is now inherited rather than self-asserted, and
  // this file locks BOTH halves: the distiller must not re-grow a spawn of its
  // own, and the primitive it delegates to must keep cwd and env in lock-step.
  test('memoryDistiller.ts delegates its spawn — no self-assembled plan or executor call', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src/modules/memory/application/distill/memoryDistiller.ts'),
      'utf-8',
    )
    expect(src).toContain('runSystemAgent')
    // One scratch for the whole follow-up chain: the name is allocated here and
    // handed to every round, because claude resolves `--resume` against the
    // cwd-slugged project dir (RFC-367 design §3).
    expect(src).toContain('scratchName')
    expect(src).toContain("join(Paths.root, 'scratch')")
    // Re-growing any of these here would re-open the PWD gap this file exists for.
    expect(src).not.toContain('buildSpawn(')
    expect(src).not.toContain('runAgentProcess(')
    expect(src).not.toContain('Bun.spawn(')
  })

  test('runSystemAgent keeps the system-agent cwd and the plan env in lock-step', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src/services/systemAgentRun.ts'),
      'utf-8',
    )
    // The isolated worktree under the caller's scratch is the ONE cwd handed to
    // both plan construction and the executor, so buildOpencodeEnv pins the same
    // PWD (ENV_PWD_SITES above) and managedProcess spawns with it (SPAWN_CWD_SITES).
    expect(src).toContain("const worktreeDir = join(scratchDir, 'worktree')")
    expect(src).toContain('cwd: worktreeDir,')
    expect(src).toContain('runAgentProcess({')
    expect(src).toContain('env: plan.env,')
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
        expect(block).toContain(`env: ${envExpr}`)
        asserted = true
      }
      expect(asserted).toBe(true)
    })
  }
})
