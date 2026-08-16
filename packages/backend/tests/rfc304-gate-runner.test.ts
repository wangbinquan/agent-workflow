// RFC-304 — running the target repository's gate, and what it does when the
// gate misbehaves.
//
// `ci-fix` proves a fix by running the gate and comparing red to green, and
// `requirement` runs it before opening a merge request. Both take the runner as
// a seam, and the scheduler supplied NEITHER it nor the file reader beside it —
// so the wiring installed the placeholder that throws `no gate runner is wired
// for this round`, and `ci-fix` could produce a change while having no way to
// say whether it worked.
//
// The cases here are the ones an end-to-end run does not reach: a gate that
// hangs, one that names a tool the host does not have, one that prints far more
// than a comment can carry, and a file reader asked for something outside the
// worktree. Each of them has an answer that is more useful than a thrown error,
// because all four end up quoted on somebody's merge request.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GATE_OUTPUT_LIMIT,
  makeGateRunner,
  makeWorktreeFileReader,
} from '../src/services/codeCapabilityGate'

const worktree = (): string => mkdtempSync(join(tmpdir(), 'rfc304-gate-'))
const isWindows = process.platform === 'win32'

describe('RFC-304 — the target repository gate runner', () => {
  test('a passing gate is green, and its output comes back', async () => {
    const dir = worktree()
    const run = makeGateRunner(dir)
    const result = await run(isWindows ? 'echo gate ok' : 'echo "gate ok"')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('gate ok')
  })

  test('a failing gate reports its exit code AND what it printed', async () => {
    // The output is the evidence: `ci-fix` feeds it to the model as "what went
    // wrong", and a non-zero exit with no text is a round nobody can act on.
    const dir = worktree()
    const run = makeGateRunner(dir)
    const result = await run(isWindows ? 'echo boom && exit 3' : 'echo boom >&2; exit 3')
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('boom')
  })

  test('stderr is merged in, not dropped', async () => {
    // A failing gate usually says why on stderr; separating the streams here
    // would hand the model half the story.
    const dir = worktree()
    const result = await makeGateRunner(dir)(
      isWindows ? 'echo to-stderr 1>&2' : 'echo to-stderr >&2',
    )
    expect(result.output).toContain('to-stderr')
  })

  test('the gate runs IN the worktree', async () => {
    // Not the daemon's cwd: a gate that runs in the wrong tree tests whatever
    // happens to be there and reports green for a change it never saw.
    const dir = worktree()
    writeFileSync(join(dir, 'marker.txt'), 'here\n')
    const result = await makeGateRunner(dir)(isWindows ? 'type marker.txt' : 'cat marker.txt')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('here')
  })

  test('a gate that hangs is a FAILED gate, not a hung round', async () => {
    // The load-bearing one. Without a timeout the round holds the merge-request
    // lease until the lease expires, and nothing on the merge request says why
    // it went quiet.
    const dir = worktree()
    const run = makeGateRunner(dir, { timeoutMs: 300 })
    const started = Date.now()
    const result = await run(isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30')
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('did not finish')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('a command this host cannot start is a failed gate that says so', async () => {
    // A repository naming a tool this deployment does not have. An exception
    // here would fail the round with a stack trace; what an operator needs is
    // the command and the reason, on the merge request.
    const dir = worktree()
    const result = await makeGateRunner(dir)('aw-definitely-not-a-real-binary --please')
    expect(result.exitCode).not.toBe(0)
    expect(result.output.length).toBeGreaterThan(0)
  })

  test('an empty gate command fails instead of running a shell for nothing', async () => {
    const result = await makeGateRunner(worktree())('   ')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('empty')
  })

  test('a gate that prints a flood is truncated, and says it was', async () => {
    // The output is quoted into a comment and fed to a model; an unbounded test
    // log would blow up both. Truncation is announced so nobody reads the tail
    // as "the gate stopped there".
    const dir = worktree()
    const script = join(dir, 'flood.js')
    writeFileSync(
      script,
      `const line = 'x'.repeat(1000)\nfor (let i = 0; i < 1000; i++) console.log(line)\n`,
    )
    const result = await makeGateRunner(dir)(`node "${script}"`)
    expect(result.output.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT + 200)
    expect(result.output).toContain('truncated')
  })
})

describe('RFC-304 — reading the file that names the gate', () => {
  test('an existing file comes back, a missing one is null rather than a throw', async () => {
    // "This repository has no CLAUDE.md" is the ordinary case for the discovery
    // loop, not an error.
    const dir = worktree()
    writeFileSync(join(dir, 'CLAUDE.md'), '# gate\n\nRun `bun run gate:local`.\n')
    const read = makeWorktreeFileReader(dir)
    expect(await read('CLAUDE.md')).toContain('gate:local')
    expect(await read('AGENTS.md')).toBeNull()
  })

  test('a nested candidate path is read', async () => {
    const dir = worktree()
    mkdirSync(join(dir, '.github'), { recursive: true })
    writeFileSync(join(dir, '.github', 'CONTRIBUTING.md'), 'run `make check`\n')
    expect(await makeWorktreeFileReader(dir)('.github/CONTRIBUTING.md')).toContain('make check')
  })

  test('a path that walks out of the worktree reads nothing', async () => {
    // The candidate list is fixed today, but the seam is generic: a `..` that
    // escaped would read whatever the daemon can reach and hand it to a model.
    const dir = worktree()
    const read = makeWorktreeFileReader(dir)
    expect(await read('../../etc/hosts')).toBeNull()
    expect(await read('/etc/hosts')).toBeNull()
  })
})
