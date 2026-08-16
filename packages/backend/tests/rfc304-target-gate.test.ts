// RFC-304 §6.3 `run-target-gate` — reading the target repository's own gate.
//
// The alternative this replaces is hardcoding a command, which would be wrong
// in most repositories and confidently so: `npm test` reports a red gate on
// every Go, Rust, Python and Bun project the platform touches.
//
// Both failure directions matter and they are not symmetric:
//
//   too eager — the platform runs something it found in a document that was not
//               a gate. `bun run dev` never exits, and the round hangs. Worse,
//               a documented multi-step recipe run unattended is a bigger
//               promise than this stage makes.
//   too shy   — no gate found, which is a stated outcome that lets the round
//               continue. Not a failure: the platform learned nothing, which is
//               different from learning the change is bad.
//
// The last property here is about honesty rather than parsing: "checks passed"
// must never be said when no gate ran.

import { describe, expect, test } from 'bun:test'
import {
  GATE_DOC_CANDIDATES,
  describeGateOutcome,
  findGateCommand,
} from '../src/modules/code-capability/domain/targetGate'

describe('RFC-304 — finding a gate command', () => {
  test('`node` is a runner like any other', () => {
    // It was missing from the list that already held `npm`, `npx`, `bun` and
    // `python`, so `Run \`node gate.js\` before you push.` — a perfectly
    // ordinary instruction — was refused, and `ci-fix` reported that it could
    // not PROVE its fix. Found by the ci-fix e2e, whose fixture named its gate
    // exactly that way.
    expect(findGateCommand('CLAUDE.md', 'Run `node gate.js` before you push.\n')?.command).toBe(
      'node gate.js',
    )
    expect(findGateCommand('CLAUDE.md', 'Run `deno task check` before you push.\n')?.command).toBe(
      'deno task check',
    )
  })

  test('inline, on the same line as the instruction', () => {
    // The commonest phrasing by a distance.
    const found = findGateCommand(
      'CLAUDE.md',
      ['# Contributing', '', 'Run `bun run gate:local` before you push.'].join('\n'),
    )
    expect(found?.command).toBe('bun run gate:local')
    expect(found?.source).toEqual({ file: 'CLAUDE.md', line: 3 })
  })

  test('in a fenced block under the instruction', () => {
    const found = findGateCommand(
      'CONTRIBUTING.md',
      ['Before you push, run:', '', '```sh', 'make check', '```'].join('\n'),
    )
    expect(found?.command).toBe('make check')
    expect(found?.source.line).toBe(4)
  })

  test('a shell prompt marker is documentation, not part of the command', () => {
    const found = findGateCommand(
      'CLAUDE.md',
      ['Before you commit, run:', '```', '$ cargo test', '```'].join('\n'),
    )
    expect(found?.command).toBe('cargo test')
  })

  test('"must be green" is recognised as a gate instruction', () => {
    const found = findGateCommand('AGENTS.md', ['`bun run test` must be all green.'].join('\n'))
    expect(found?.command).toBe('bun run test')
  })

  test('the FIRST plausible command wins, not the "best" one', () => {
    // Judging which of two is the real gate needs judgement, and a wrong guess
    // fails an honest change. First is a rule; best is an opinion.
    const found = findGateCommand(
      'CLAUDE.md',
      ['Run `make lint` before you push.', 'Also `make test` before you push.'].join('\n'),
    )
    expect(found?.command).toBe('make lint')
  })
})

describe('RFC-304 — what is NOT adopted as a gate', () => {
  test('a dev server is refused', () => {
    // `bun run dev` never exits. A round gated on it hangs until the timeout.
    expect(
      findGateCommand('CLAUDE.md', 'Before you push, start `bun run dev` and check the page.'),
    ).toBeNull()
    expect(findGateCommand('CLAUDE.md', 'Before you push: `npm start`')).toBeNull()
    expect(findGateCommand('CLAUDE.md', 'Before you push run `vitest --watch`')).toBeNull()
  })

  test('a multi-statement recipe is refused', () => {
    // A documented sequence is a recipe for a human; running it unattended is a
    // bigger promise than this stage makes.
    expect(findGateCommand('CLAUDE.md', 'Before you push run `bun install && bun test`')).toBeNull()
    expect(findGateCommand('CLAUDE.md', 'Before you push run `make a; make b`')).toBeNull()
  })

  test('prose in backticks is not a command', () => {
    expect(
      findGateCommand('CLAUDE.md', 'Before you push, make sure `everything is working fine`'),
    ).toBeNull()
  })

  test('a document with no gate instruction yields nothing', () => {
    // "run the dev server" must not be picked up just for containing "run".
    const found = findGateCommand(
      'README.md',
      ['# Project', '', 'To run the dev server: `bun run dev`.'].join('\n'),
    )
    expect(found).toBeNull()
  })

  test('an instruction with no command nearby yields nothing', () => {
    // The fenced block is eight lines away — far enough that it is a different
    // topic, and adopting it would run something unrelated.
    const found = findGateCommand(
      'CLAUDE.md',
      [
        'Everything must be green before you push.',
        '',
        'Some prose.',
        'More prose.',
        'Yet more.',
        'And more.',
        'Still more.',
        '```',
        'echo unrelated',
        '```',
      ].join('\n'),
    )
    expect(found).toBeNull()
  })

  test('an empty document is not a crash', () => {
    expect(findGateCommand('CLAUDE.md', '')).toBeNull()
  })
})

describe('RFC-304 — what the merge request is told', () => {
  const source = { file: 'CLAUDE.md', line: 12 }

  test('a passing gate names the command AND where it came from', () => {
    // Where it came from is what lets a reviewer tell whether the platform ran
    // the right thing.
    const text = describeGateOutcome({ kind: 'passed', command: 'bun run gate:local', source })
    expect(text).toContain('bun run gate:local')
    expect(text).toContain('CLAUDE.md:12')
    expect(text).toContain('passed')
  })

  test('NOT FOUND never reads as "checks passed"', () => {
    // The most damaging thing this module could say. A reviewer's first
    // question about an automated change is "was this checked?".
    const text = describeGateOutcome({ kind: 'not-found', searched: [...GATE_DOC_CANDIDATES] })
    expect(text.toLowerCase()).not.toContain('passed')
    expect(text).toContain('nothing was verified')
    // And it says WHERE it looked, so the fix is obvious.
    expect(text).toContain('CLAUDE.md')
  })

  test('unrunnable is distinguished from failed', () => {
    // "The gate could not be run" and "the gate says your change is broken" are
    // opposite messages to the person reading the merge request.
    const text = describeGateOutcome({
      kind: 'unrunnable',
      command: 'make check',
      reason: 'make is not installed',
    })
    expect(text).not.toContain('FAILED')
    expect(text).toContain('nothing was verified')
  })

  test('a failing gate is unmistakable', () => {
    const text = describeGateOutcome({
      kind: 'failed',
      command: 'make check',
      source,
      output: '...',
    })
    expect(text).toContain('FAILED')
  })
})
