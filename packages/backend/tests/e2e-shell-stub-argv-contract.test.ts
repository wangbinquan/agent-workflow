// Guard: the Playwright e2e SHELL stubs must extract the prompt from the SAME
// argv layout that runtime/opencode/spawn.ts's buildCommand actually emits.
//
// WHY THIS EXISTS (design/test-guard-audit-2026-07-21 — a live escape)
// -------------------------------------------------------------------
// 191bc32c moved the opencode prompt from a bare positional after `run` to a
// TRAILING positional after a `--` end-of-options separator
// (`run --agent … -- <prompt>`), to stop opencode's strict parser from treating
// a `-`-leading prompt as an unknown flag. That commit updated spawn.ts, the
// runtime-opencode-golden test, AND the 23 INLINE TS opencode fixtures
// (tests/fixtures/{mock,scenario,stubborn}-opencode.ts) — but it did NOT touch
// the SIX SHELL stubs under e2e/fixtures/, which still read the prompt from
// `${2-}` / `shift; ${1-}`. Post-change `$2` is `--agent`, so the RFC-200 nonce
// was missing → every stub `exit 3`'d → EVERY task-execution e2e failed with a
// baffling "opencode exited with code 3" on the first agent node (3ff96843:
// e2e shards 1-3 red, shard 4 — pure UI — green). It was closed by 8338f393.
//
// The escape: the golden test and the TS fixtures pinned the argv contract, but
// NOTHING tied the shell stubs to that same contract, so the two stub families
// drifted and only the slow, expensive e2e caught it (as a mass mystery
// failure). This test closes that gap CHEAPLY: it derives the argv straight
// from buildCommand — the real producer — and spawns each shell stub with it,
// so a future layout change that a stub can't parse reds HERE, in the fast
// backend suite, long before the e2e runs.
//
// MUTATION CHECK (manually verified): revert any stub's prompt extraction to
// `RAW_PROMPT="${2-}"` and that stub receives `--agent` instead of the prompt →
// no nonce → `exit 3` → its case below reds.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildCommand } from '../src/services/runtime/opencode/spawn'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const STUB_DIR = resolve(REPO_ROOT, 'e2e', 'fixtures')

const NONCE = 'AWNONCE_argv_contract_9f3c'
// A realistic prompt: leads with `-` (the exact shape that forced the `--`
// layout — the RFC-200 untrusted-input boundary begins with `---`) and carries
// the RFC-200 nonce the stub must echo back.
const PROMPT = `---\n**Untrusted input boundary.** Design the thing.\nEmit <workflow-output nonce="${NONCE}">.`

const scratch: string[] = []
function tmp(): string {
  const d = mkdtempSync(resolve(tmpdir(), 'aw-stub-argv-'))
  scratch.push(d)
  return d
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

/**
 * Spawn one shell stub with the argv that spawn.ts's buildCommand REALLY emits
 * (only the leading binary is swapped for `/bin/sh <stub>`), returning its exit
 * code and stdout. Deriving argv from buildCommand is the whole point: the
 * layout under test is the production layout, not a hand-copied guess.
 */
function runStub(
  stub: string,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { code: number | null; stdout: string; stderr: string } {
  const stubPath = resolve(STUB_DIR, stub)
  // opencodeCmd replaces `head`, so cmd = ['/bin/sh', stubPath, 'run', '--agent',
  // 'x', '--format', 'json', '--thinking', '--dangerously-skip-permissions',
  // '--', PROMPT] — byte-identical flag order to a real opencode spawn.
  const cmd = buildCommand({ agent: { name: 'x' }, opencodeCmd: ['/bin/sh', stubPath] }, PROMPT)
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd ?? tmp(),
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('e2e shell stubs parse the buildCommand argv layout (post-191bc32c `--` regression guard)', () => {
  // Every stub: MUST NOT exit 3 (the "prompt missing nonce" sentinel), MUST
  // exit 0, and MUST echo the nonce back in an envelope it emitted.
  const cases: Array<{ name: string; env?: () => Record<string, string> }> = [
    { name: 'stub-opencode.sh' },
    { name: 'stub-opencode-commit.sh' },
    { name: 'stub-opencode-slow.sh' },
    { name: 'stub-opencode-clarify.sh', env: () => ({ CLARIFY_STUB_STATE: tmp() }) },
    { name: 'stub-opencode-cross-clarify.sh', env: () => ({ CROSS_CLARIFY_STUB_STATE: tmp() }) },
    {
      name: 'stub-opencode-clarify-inline.sh',
      env: () => {
        const d = tmp()
        return { CLARIFY_STUB_STATE: d, CLARIFY_INLINE_ARGV_LOG: resolve(d, 'argv.log') }
      },
    },
  ]

  for (const c of cases) {
    test(`${c.name} finds the prompt after \`--\` and echoes the nonce`, () => {
      const r = runStub(c.name, { env: c.env?.() })
      // The exact failure the regression produced: `exit 3` because $2 was a flag.
      expect(`${c.name} exit=${r.code} stderr=${r.stderr.trim()}`).not.toContain('exit=3')
      expect(r.code).toBe(0)
      // Nonce round-trips → the stub read the real prompt, not a flag.
      expect(r.stdout).toContain(NONCE)
    })
  }

  test('buildCommand still delivers the prompt as a trailing `--` positional (contract anchor)', () => {
    // If this ever changes, the spawns above are what verify the stubs kept up;
    // this assertion documents the coupling so a reader knows why the stubs care.
    const cmd = buildCommand({ agent: { name: 'x' }, opencodeCmd: ['opencode'] }, PROMPT)
    const dd = cmd.indexOf('--')
    expect(dd).toBeGreaterThanOrEqual(0)
    expect(cmd[dd + 1]).toBe(PROMPT)
    expect(cmd.slice(dd + 1)).toHaveLength(1) // prompt is the LAST element
  })
})
