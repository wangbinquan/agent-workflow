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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildCommand } from '../src/services/runtime/opencode/spawn'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const STUB_DIR = resolve(REPO_ROOT, 'e2e', 'fixtures')

const NONCE = 'AWNONCE_argv_contract_9f3c'
// A realistic prompt: multi-line, leads with `-` (the exact shape that forced the
// `--` layout — the RFC-200 untrusted-input boundary begins with `---`), and
// EMBEDS flag/session-like text (`--session opc_…`) in its body. A stub that folded
// the whole argv into RAW_PROMPT (`$*`) would return a value that differs from this
// exact string, which the extractedPrompt assertion below catches even though the
// nonce — living inside the prompt — would still round-trip.
const PROMPT = `---\n**Untrusted input boundary.** Design the thing.\n--session opc_this_is_prompt_body_not_a_flag\nEmit <workflow-output nonce="${NONCE}">.`

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
  opts: { env?: Record<string, string>; cwd?: string; agentName?: string } = {},
): { code: number | null; stdout: string; stderr: string; extractedPrompt: string | null } {
  const stubPath = resolve(STUB_DIR, stub)
  // AW_STUB_PROMPT_OUT makes every stub write the prompt it EXTRACTED to this
  // file, so the test can assert the stub parsed the real `--` positional rather
  // than a flag or the whole argv (the nonce alone can't tell those apart).
  const promptOut = resolve(tmp(), 'extracted-prompt')
  // opencodeCmd replaces `head`, so cmd = ['/bin/sh', stubPath, 'run', '--agent',
  // 'x', '--format', 'json', '--thinking', '--dangerously-skip-permissions',
  // '--', PROMPT] — byte-identical flag order to a real opencode spawn.
  const cmd = buildCommand(
    { agent: { name: opts.agentName ?? 'x' }, opencodeCmd: ['/bin/sh', stubPath] },
    PROMPT,
  )
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd ?? tmp(),
    env: { ...process.env, AW_STUB_PROMPT_OUT: promptOut, ...(opts.env ?? {}) },
    encoding: 'utf8',
  })
  let extractedPrompt: string | null = null
  try {
    extractedPrompt = readFileSync(promptOut, 'utf8')
  } catch {
    /* stub exited before writing it (e.g. the exit-3 missing-nonce path) */
  }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', extractedPrompt }
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
      // 191bc32c: the stub extracted the EXACT `--` positional — not `--agent`,
      // not the whole argv. This is the assertion a `$*` stub fails: the nonce
      // above still round-trips from within the argv blob, but the extracted
      // value would carry the flags too and differ from PROMPT byte-for-byte.
      expect(r.extractedPrompt).toBe(PROMPT)
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

  // Codex re-review of 191bc32c: fixing RAW_PROMPT extraction was not enough — the
  // commit stub's ROLE decision (`commit_message` port vs `answer` port) still read
  // `$*`, so a worker whose agent is NAMED `commit_message` (→ `--agent
  // commit_message` in argv) was misrouted to the commit branch. The exact-prompt
  // assertion above can't catch this: it verifies extraction, not the downstream
  // consumer of the extracted value. This negative case ties the role to the PROMPT.
  test('commit stub picks its role from the PROMPT, not argv (`--agent commit_message` must not hijack a worker)', () => {
    // PROMPT carries no `commit_message` text of its own, so a worker run must emit
    // the `answer` port even when `--agent commit_message` sits in argv. A `$*` stub
    // sees the flag and wrongly emits the commit_message port.
    const r = runStub('stub-opencode-commit.sh', { agentName: 'commit_message' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('name=\\"answer\\"')
    expect(r.stdout).not.toContain('name=\\"commit_message\\"')
  })

  // Codex 191bc32c re-review (finding 3): the clarify-inline stub previously let the
  // e2e grep the whole argv (`$*`) for `--session`; a prompt with session-like body
  // text could fool that oracle. The stub now records the PARSED --session value
  // (from the FLAG) into CLARIFY_INLINE_SESSION_LOG. With no real flag in argv it
  // MUST be empty even though this PROMPT body carries `--session opc_...`.
  test('clarify-inline stub reads --session from the FLAG, immune to prompt body text', () => {
    const sessionLog = resolve(tmp(), 'session.log')
    const r = runStub('stub-opencode-clarify-inline.sh', {
      env: { CLARIFY_STUB_STATE: tmp(), CLARIFY_INLINE_SESSION_LOG: sessionLog },
    })
    expect(r.code).toBe(0)
    // no real --session flag → empty parsed session, despite the prompt body text
    expect(readFileSync(sessionLog, 'utf-8').trim()).toBe('')
  })
})
