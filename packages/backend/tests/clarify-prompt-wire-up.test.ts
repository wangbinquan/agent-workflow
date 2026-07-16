// RFC-023 PR-B T12 — locks the scheduler ↔ runner wiring for clarify prompt
// context.
//
// RFC-058 T13 update: scheduler now calls the unified
// `buildPromptContext` from `services/clarifyRounds.ts` (consumerKind dispatch)
// instead of `buildClarifyPromptContext` / `buildQuestionerCrossClarifyContext`.
//
// Source-level guards (no runtime needed) keep the wire-up from rotting:
//   1. scheduler.ts MUST call buildPromptContext at the agent-single
//      AND agent-multi shard sites.
//   2. runner.ts MUST thread the `clarifyChannel` ADT (RFC-148; historical
//      hasClarifyChannel) into renderUserPrompt and
//      call detectEnvelopeKind / extractClarifyEnvelopeBody on stdout —
//      without these the agent never sees the protocol rules and replies
//      never get routed into the clarify path. (extractClarifyEnvelopeBody is
//      also asserted by clarify-envelope-exclusive.test.ts via runner.ts grep
//      — duplicating here so a future split of that file doesn't silently
//      drop this one.)
//   3. shared/src/prompt.ts MUST still call buildClarifyProtocolBlock — the
//      bi-modal rewrite (RFC-039: ask-back-default preamble for output + clarify)
//      moved this call out of runner.ts and into renderUserPrompt so the
//      mandatory ask-back preamble (RFC-148: gated on the clarifyChannel ADT's
//      directive === 'mandatory' projection) and
//      the clarify-format block always travel together. Asserting on the
//      shared file keeps the lock without re-tightening runner.ts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKEND_SRC = join(__dirname, '..', 'src', 'services')
const SHARED_SRC = join(__dirname, '..', '..', 'shared', 'src')

describe('scheduler ↔ runner clarify prompt wire-up (RFC-023 T12)', () => {
  test('scheduler.ts wires the unified buildClarifyQueueContext injector (RFC-132 PR-C)', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    // RFC-132 (PR-C): one flat injector replaces the former self/questioner + designer split.
    // selectAgentQueue queries every role in one shot, so there is no per-role consumerKind SELECT
    // fork and no round-grouped buildPromptContext call in the scheduler anymore.
    expect(src).toContain('await buildClarifyQueueContext(')
    expect(src).not.toContain('await buildPromptContext(')
    expect(src).not.toContain("consumerKind: 'self'")
    expect(src).not.toContain("consumerKind: 'cross-questioner'")
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

  test('runner.ts threads the clarifyChannel ADT into renderUserPrompt', () => {
    const src = readFileSync(join(BACKEND_SRC, 'runner.ts'), 'utf8')
    // RFC-148: the channel rides through whole — renderUserPrompt projects
    // mandatory ask-back / the stop notice from it (was: hasClarifyChannel).
    expect(src).toContain('clarifyChannel: opts.clarifyChannel')
    // The actual `buildClarifyProtocolBlock` call now lives inside
    // renderUserPrompt (shared/src/prompt.ts) so the bi-modal protocol
    // preamble and the clarify-format block always travel together. Asserting
    // that wire-up is in `shared/src/prompt.ts mounts buildClarifyProtocolBlock`
    // below.
  })

  test('shared/src/prompt.ts mounts buildClarifyProtocolBlock inside renderUserPrompt', () => {
    const src = readFileSync(join(SHARED_SRC, 'prompt.ts'), 'utf8')
    // RFC-200 threads the per-run envelope nonce through the mandatory clarify
    // protocol instead of rendering the historical bare-tag block.
    expect(src).toContain('const nonce = input.envelopeNonce')
    expect(src).toContain('buildClarifyProtocolBlock(nonce)')
    // RFC-100: the clarify-active path mounts the mandatory ask-back preamble +
    // clarify format, gated on the clarifyChannel ADT's mandatory projection
    // (RFC-148 — was `hasClarifyChannel === true`). The bi-modal
    // `buildProtocolBlock(input.agentOutputs, true, ...)` call was removed —
    // while clarify is active the agent is given NO `<workflow-output>` format.
    // RFC-183: the projection routes through the shared clarifyDispositionFor
    // classifier (the runner consumes the SAME one — invite⟺accept 同源).
    expect(src).toContain('buildMandatoryClarifyPreamble()')
    expect(src).toContain("disposition === 'invite-mandatory'")
    expect(src).toContain('clarifyDispositionFor(channel.directive)')
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
  test('scheduler.ts gates effectiveHasClarifyChannel on the per-node clarify state (RFC-132 PR-C)', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    // RFC-132 (PR-C §7): the standing continue/stop directive is the per-node clarify state — the
    // scheduler feeds `nodeDirective` into resolveEffectiveClarifyChannel (the flat context carries
    // no directive). Assert the wiring here AND the gate itself in the oracle.
    expect(src).toContain('contextDirective: nodeDirective')
    expect(src).not.toContain('clarifyContext?.directive')
    const oracleSrc = readFileSync(join(BACKEND_SRC, 'clarifyRounds.ts'), 'utf8')
    expect(oracleSrc).toContain("args.contextDirective !== 'stop'")
    const occurrences = src.match(/effectiveHasClarifyChannel/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  // The agent-single buildPromptContext call MUST pass the shared
  // `applyLatestDirective` local (= `isClarifyRerun || reviewContext === undefined`,
  // RFC-100 Codex review #2). The prior round's directive='stop' suppresses the
  // IMMEDIATE clarify-rerun (the continuation row the legacy quick channel minted)
  // AND any non-review-driven process-retry / revival of that same round (so a
  // 'stop' finalize stays released across retries instead of being re-forced into
  // ask-back). Only a review-iterate rerun (reviewContext set) strips the
  // directive while addressing fresh reviewer comments. See
  // clarify-stop-directive-scoped-to-clarify-rerun.test.ts.
  test('scheduler.ts reads the standing directive from the per-node clarify state (RFC-132 PR-C)', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    // RFC-132 (PR-C §7): the per-round directive plumbing (applyLatestDirective) is gone; the
    // directive is nodeDirective (getNodeClarifyDirectiveRow) + nodeStopOverride.
    expect(src).not.toContain('applyLatestDirective')
    expect(src).toContain('const nodeDirective = nodeDirectiveRow?.directive')
    expect(src).toContain('const nodeStopOverride = nodeDirective === ')
  })

  // RFC-058 T13 + T17 was a grep guard on the single `computeHistoryCutoff`
  // call site. RFC-070 deletes `computeHistoryCutoff` entirely (aging is now
  // per-row state, see `rfc070-aging-stamp-grep-guards.test.ts`). The
  // single-source-of-truth invariant is preserved by the C-guard suite that
  // asserts `computeHistoryCutoff` is gone from src/ entirely.
  test('scheduler.ts has no inline aging cutoff lookup (RFC-058 缺口 1 stays closed under RFC-070)', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).not.toContain('computeHistoryCutoff')
    expect(src).not.toMatch(/eligible\.push\(r\)/)
    expect(src).not.toMatch(/haveOutputs\.has\(r\.id\)/)
  })
})
