// RFC-023 PR-B T12 — locks the scheduler ↔ runner wiring for clarify prompt
// context.
//
// Source-level guards (no runtime needed) keep the wire-up from rotting:
//   1. scheduler.ts MUST call buildClarifyPromptContext at the agent-single
//      AND agent-multi shard sites.
//   2. runner.ts MUST thread `hasClarifyChannel` into renderUserPrompt and
//      call detectEnvelopeKind / extractClarifyEnvelopeBody on stdout —
//      without these the agent never sees the protocol rules and replies
//      never get routed into the clarify path. (extractClarifyEnvelopeBody is
//      also asserted by clarify-envelope-exclusive.test.ts via runner.ts grep
//      — duplicating here so a future split of that file doesn't silently
//      drop this one.)
//   3. shared/src/prompt.ts MUST still call buildClarifyProtocolBlock — the
//      bi-modal rewrite (output + clarify presented as equally first-class)
//      moved this call out of runner.ts and into renderUserPrompt so the
//      preamble in `buildProtocolBlock(outputs, hasClarifyChannel=true)` and
//      the clarify-format block always travel together. Asserting on the
//      shared file keeps the lock without re-tightening runner.ts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKEND_SRC = join(__dirname, '..', 'src', 'services')
const SHARED_SRC = join(__dirname, '..', '..', 'shared', 'src')

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

  test('runner.ts threads hasClarifyChannel into renderUserPrompt', () => {
    const src = readFileSync(join(BACKEND_SRC, 'runner.ts'), 'utf8')
    expect(src).toContain('hasClarifyChannel')
    // The actual `buildClarifyProtocolBlock` call now lives inside
    // renderUserPrompt (shared/src/prompt.ts) so the bi-modal protocol
    // preamble and the clarify-format block always travel together. Asserting
    // that wire-up is in `shared/src/prompt.ts mounts buildClarifyProtocolBlock`
    // below.
  })

  test('shared/src/prompt.ts mounts buildClarifyProtocolBlock inside renderUserPrompt', () => {
    const src = readFileSync(join(SHARED_SRC, 'prompt.ts'), 'utf8')
    expect(src).toContain('buildClarifyProtocolBlock()')
    expect(src).toContain('buildProtocolBlock(input.agentOutputs, true)')
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

  // RFC-023 directive iteration — both scheduler call sites MUST consult the
  // prompt context's directive and feed an `effectiveHasClarifyChannel` flag
  // into runNode. A future refactor that removes the override silently
  // re-enables the <workflow-clarify> protocol block for stop-clarify reruns
  // (the user explicitly asked for it not to appear), so this grep guard is
  // the cheapest way to lock the contract without spinning up a full
  // scheduler integration test.
  test('scheduler.ts gates hasClarifyChannel on clarifyContext.directive !== "stop" at both sites', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).toContain("clarifyContext?.directive !== 'stop'")
    const occurrences = src.match(/effectiveHasClarifyChannel/g) ?? []
    // Two declarations + two passes into runNode → expect ≥ 4 mentions.
    expect(occurrences.length).toBeGreaterThanOrEqual(4)
  })
})
