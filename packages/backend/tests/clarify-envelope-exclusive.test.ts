// RFC-023 PR-B C1 — locks in the exclusive-or contract between
// <workflow-output> and <workflow-clarify> in any single agent stdout.
//
// Why this exists separately: detectEnvelopeKind's 'both' branch is the only
// place we centrally reject "agent tried to do both at once" replies. The
// hard rule lives in the protocol block we append to the user prompt
// (services/runner.ts → shared/prompt.ts:buildClarifyProtocolBlock). If a
// future refactor relaxes detectEnvelopeKind to e.g. "use whichever appears
// last", that change MUST cascade through the runner branch + e2e harness
// AND this guard test must be updated explicitly. Keep the assertion simple
// so the failure message points straight at the regression.
//
// This file also grep-asserts that the detectEnvelopeKind helper is the one
// runner.ts calls on the envelope kind branch — moving the branch elsewhere
// without renaming the helper would silently bypass the guard.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectEnvelopeKind } from '../src/services/envelope'

describe('clarify ↔ output envelopes are exclusive-or per reply', () => {
  test('stdout with BOTH envelopes is detected as "both" (caller must reject)', () => {
    const out = '<workflow-output><port name="x">v</port></workflow-output>'
    const clar =
      '<workflow-clarify>{"questions":[{"id":"q","title":"?","kind":"single","recommended":false,"options":["A","B"]}]}</workflow-clarify>'
    expect(detectEnvelopeKind(`${out}\n${clar}`)).toBe('both')
    expect(detectEnvelopeKind(`${clar}\n${out}`)).toBe('both')
  })

  test('stdout with NEITHER envelope is detected as "none" (caller must fail)', () => {
    expect(detectEnvelopeKind('   ')).toBe('none')
    expect(detectEnvelopeKind('agent says hi but never wraps anything')).toBe('none')
  })

  test('runner.ts wires detectEnvelopeKind so the exclusive-or rule executes', () => {
    // Source-level guard: runner.ts MUST import & call detectEnvelopeKind on
    // the agent stdout. If somebody refactors the call site away, this fails
    // with a clear pointer to the missing wiring.
    const runnerPath = join(__dirname, '..', 'src', 'services', 'runner.ts')
    const src = readFileSync(runnerPath, 'utf8')
    expect(src).toContain('detectEnvelopeKind')
    expect(src).toContain('extractClarifyEnvelopeBody')
  })
})
