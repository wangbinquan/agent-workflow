// RFC-304 §6.1 — the `review` stage end to end against a scripted model.
//
// What is being locked here is the seam, not the schema (that has its own
// tests): the stage builds the prompt, seals the answer in the envelope
// contract, and hands the determinism guard the semantic check — so a model
// that answers badly gets re-asked with feedback it can act on, and a model
// that keeps answering badly produces NO value rather than a partial one.
//
// The dispatch is injected as a prompt→caller factory. That is also a boundary
// this suite asserts: a capability that reaches into the scheduler re-creates
// the coupling RFC-294 removes.

import { describe, expect, test } from 'bun:test'
import { runReviewStage, REVIEW_PORT } from '../src/modules/code-capability/application/reviewStage'
import { parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'
import type { AiCaller } from '../src/modules/code-capability/application/determinismGuard'

const NONCE = 'reviewnonce'
const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context
-removed
+added
 context2
`

const envelope = (body: string): string =>
  `<workflow-output nonce="${NONCE}"><port name="${REVIEW_PORT}">${body}</port></workflow-output>`

const FINDING = {
  file: 'src/a.ts',
  line: 12,
  severity: 'major',
  title: 'unchecked index',
  body: 'This can be undefined when the list is empty.',
}

/** Replies with each scripted stdout in turn, recording the prompts it saw. */
function scriptedModel(replies: string[]): {
  makeCaller: (prompt: string, port: string) => AiCaller
  prompts: string[]
  /** The port each call asked for — see the test that pins it. */
  ports: string[]
  inputs: Array<{ sessionId: string | null; feedback: string | null }>
} {
  const prompts: string[] = []
  const ports: string[] = []
  const inputs: Array<{ sessionId: string | null; feedback: string | null }> = []
  let turn = 0
  return {
    prompts,
    ports,
    inputs,
    makeCaller(prompt, port) {
      prompts.push(prompt)
      ports.push(port)
      return async (input) => {
        inputs.push({ sessionId: input.sessionId, feedback: input.feedback })
        const stdout = replies[Math.min(turn, replies.length - 1)] ?? ''
        turn += 1
        return { stdout, sessionId: `session-${turn}` }
      }
    },
  }
}

const run = (replies: string[], budget = { sameSession: 2, freshSession: 1 }) =>
  runReviewStage({
    makeCaller: scriptedModel(replies).makeCaller,
    nonce: NONCE,
    budget,
    unifiedDiff: DIFF,
    hunks: parseDiffHunks(DIFF),
    omitted: [],
    mrTitle: 'Add retry logic',
  })

describe('RFC-304 — the review stage produces validated findings or nothing', () => {
  test('a well-formed answer comes back parsed', async () => {
    const { outcome } = await run([envelope(JSON.stringify({ findings: [FINDING] }))])
    expect(outcome.status).toBe('ok')
    expect(outcome.status === 'ok' && outcome.value.findings[0]?.file).toBe('src/a.ts')
  })

  test('an empty review is a successful outcome, not a failure', async () => {
    // The stage must be able to say "nothing wrong here". If an empty answer
    // failed, the only way to succeed would be to find something.
    const { outcome } = await run([envelope(JSON.stringify({ findings: [] }))])
    expect(outcome.status).toBe('ok')
    expect(outcome.status === 'ok' && outcome.value.findings).toEqual([])
  })

  test('the default side is applied to a finding that omits it', async () => {
    const { outcome } = await run([envelope(JSON.stringify({ findings: [FINDING] }))])
    expect(outcome.status === 'ok' && outcome.value.findings[0]?.side).toBe('new')
  })

  test('a malformed answer is retried and the retry can succeed', async () => {
    const { outcome } = await run([
      envelope('not json at all'),
      envelope(JSON.stringify({ findings: [FINDING] })),
    ])
    expect(outcome.status).toBe('ok')
    expect(outcome.status === 'ok' && outcome.totalCalls).toBe(2)
  })

  test('semantic problems are retried too, not just schema ones', async () => {
    // A duplicate passes the schema and would publish the same comment twice.
    const { outcome } = await run([
      envelope(JSON.stringify({ findings: [FINDING, FINDING] })),
      envelope(JSON.stringify({ findings: [FINDING] })),
    ])
    expect(outcome.status).toBe('ok')
    expect(outcome.status === 'ok' && outcome.totalCalls).toBe(2)
  })

  test('a model that never conforms yields NO value at all', async () => {
    // Constitution R5. A partial or best-effort value escaping here would be
    // published as a review comment with nothing marking it as unvalidated.
    const { outcome } = await run([envelope('still not json')])
    expect(outcome.status).toBe('exhausted')
    expect(outcome.status === 'exhausted' && outcome.rejections.length).toBeGreaterThan(0)
    expect('value' in outcome).toBe(false)
  })
})

describe('RFC-304 — what the stage hands the model', () => {
  test('the stage names the port it will validate', async () => {
    // What the protocol block is built from, one level up. The stage used to
    // append a block handed to it ready-made, and the scheduler built that
    // block — and the caller that reads the reply — around THIS port for every
    // capability, so `mr-comment-fix`, `requirement` and `ci-fix` each asked
    // for `findings` and then waited on a port nothing wrote. Passing the port
    // out from the stage that validates it is what removed the chance to
    // disagree, and this pins that it is still the guard's own port.
    const model = scriptedModel([envelope(JSON.stringify({ findings: [] }))])
    await runReviewStage({
      makeCaller: model.makeCaller,
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      unifiedDiff: DIFF,
      hunks: parseDiffHunks(DIFF),
      omitted: [],
      mrTitle: null,
    })
    expect(model.ports).toEqual([REVIEW_PORT])
  })

  test('the prompt carries the diff and the permission to find nothing', async () => {
    const model = scriptedModel([envelope(JSON.stringify({ findings: [] }))])
    await runReviewStage({
      makeCaller: model.makeCaller,
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      unifiedDiff: DIFF,
      hunks: parseDiffHunks(DIFF),
      omitted: [],
      mrTitle: null,
    })
    expect(model.prompts[0]).toContain('@@ -10,3 +10,4 @@')
    expect(model.prompts[0]).toContain('report no findings at all')
  })

  test('a retry carries feedback; the first attempt of a session does not', async () => {
    const model = scriptedModel([
      envelope('bad'),
      envelope(JSON.stringify({ findings: [FINDING] })),
    ])
    await runReviewStage({
      makeCaller: model.makeCaller,
      nonce: NONCE,
      budget: { sameSession: 2, freshSession: 0 },
      unifiedDiff: DIFF,
      hunks: parseDiffHunks(DIFF),
      omitted: [],
      mrTitle: null,
    })
    expect(model.inputs[0]?.feedback).toBeNull()
    expect(model.inputs[1]?.feedback).toBeTruthy()
  })

  test('the clipped flag rides out with the outcome', async () => {
    // The overview comment needs it: a review of a clipped diff is partial, and
    // saying so is the difference between a limitation and a wrong answer.
    const model = scriptedModel([envelope(JSON.stringify({ findings: [] }))])
    const result = await runReviewStage({
      makeCaller: model.makeCaller,
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      unifiedDiff: DIFF,
      hunks: parseDiffHunks(DIFF),
      omitted: [],
      mrTitle: null,
    })
    expect(result.diffClipped).toBe(false)
  })
})
