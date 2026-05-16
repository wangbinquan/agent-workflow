// RFC-023 PR-B T12 — locks the scheduler ↔ runner wiring for clarify prompt
// context.
//
// Two source-level guards (no runtime needed) keep the wire-up from rotting:
//   1. scheduler.ts MUST call buildClarifyPromptContext at the agent-single
//      AND agent-multi shard sites.
//   2. runner.ts MUST call buildClarifyProtocolBlock and detectEnvelopeKind /
//      extractClarifyEnvelopeBody — without these calls, the agent never
//      sees the protocol rules and replies never get routed into the
//      clarify path. (extractClarifyEnvelopeBody is also asserted by
//      clarify-envelope-exclusive.test.ts via runner.ts grep — duplicating
//      here so a future split of that file doesn't silently drop this one.)

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKEND_SRC = join(__dirname, '..', 'src', 'services')

describe('scheduler ↔ runner clarify prompt wire-up (RFC-023 T12)', () => {
  test('scheduler.ts wires buildClarifyPromptContext on both agent paths', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).toContain('buildClarifyPromptContext')
    // Two call sites in runOneNode (agent-single) and runFanOutNode (agent-multi).
    const occurrences = src.match(/buildClarifyPromptContext\(/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  test('scheduler.ts wires findClarifyNodeForAgent + agentHasClarifyChannel', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).toContain('findClarifyNodeForAgent')
    expect(src).toContain('agentHasClarifyChannel')
  })

  test('scheduler.ts wires createClarifySession into the agent-single path', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).toContain('createClarifySession')
  })

  test('runner.ts wires buildClarifyProtocolBlock onto the user prompt', () => {
    const src = readFileSync(join(BACKEND_SRC, 'runner.ts'), 'utf8')
    expect(src).toContain('buildClarifyProtocolBlock')
    // Also receives the hasClarifyChannel switch.
    expect(src).toContain('hasClarifyChannel')
  })

  test('runner.ts wires detectEnvelopeKind + extractClarifyEnvelopeBody for the envelope kind branch', () => {
    const src = readFileSync(join(BACKEND_SRC, 'runner.ts'), 'utf8')
    expect(src).toContain('detectEnvelopeKind')
    expect(src).toContain('extractClarifyEnvelopeBody')
    expect(src).toContain('parseClarifyEnvelopeBody')
  })

  test('runner.ts threads clarifyContext through to renderUserPrompt', () => {
    const src = readFileSync(join(BACKEND_SRC, 'runner.ts'), 'utf8')
    expect(src).toContain('clarifyContext')
  })
})
