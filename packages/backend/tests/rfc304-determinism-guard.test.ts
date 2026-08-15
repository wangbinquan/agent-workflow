// RFC-304 T6 — the determinism guard (constitution R3/R4/R5).
//
// The claim under test is strong and worth stating plainly: NOTHING downstream
// of an AI stage ever sees anything but a value that conformed to the declared
// schema. There is no "whatever the model said" path out of `runGuardedAiStage`
// — which is why the exhausted case returns a distinct status rather than a
// best-effort value.
//
// Three things get the most attention, because each has a wrong version that
// looks right:
//
//  1. The two retry LEVELS are different, not one budget spelled twice. A
//     same-session retry keeps the context of the code the model already read
//     and carries the specific error; a fresh session drops both, because a
//     model that has convinced itself of a wrong frame keeps producing the same
//     malformed answer no matter how politely you correct it in place.
//  2. Feedback must be ACTIONABLE. "Invalid output" burns an attempt and
//     teaches nothing, so the assertions check the feedback names the field.
//  3. A transport failure is not a validation failure — there is no output to
//     give feedback about, so the next attempt must not tell the model to fix
//     an error it did not make.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  runGuardedAiStage,
  type AiCallInput,
  type AiCaller,
  type AttemptRecorder,
} from '../src/modules/code-capability/application/determinismGuard'
import { judgeEnvelope } from '../src/modules/code-capability/domain/envelopeVerdict'

const NONCE = 'guardnonce'
const PORT = 'findings'

const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(['blocker', 'major', 'minor']),
  message: z.string().min(1),
})
const FindingsSchema = z.object({ findings: z.array(FindingSchema) })

const envelope = (body: string, nonce = NONCE): string =>
  `<workflow-output nonce="${nonce}"><port name="${PORT}">${body}</port></workflow-output>`

const VALID = JSON.stringify({
  findings: [{ file: 'a.ts', line: 12, severity: 'major', message: 'unchecked error' }],
})

/** A caller scripted with one reply per call, recording what it was handed. */
function scriptedCaller(replies: string[]): { caller: AiCaller; seen: AiCallInput[] } {
  const seen: AiCallInput[] = []
  let i = 0
  const caller: AiCaller = async (input) => {
    seen.push(input)
    const stdout = replies[Math.min(i, replies.length - 1)] ?? ''
    i++
    // A real driver mints a session id on the first call of a session and
    // returns the same one while it continues.
    return { stdout, sessionId: input.sessionId ?? `session-${seen.length}` }
  }
  return { caller, seen }
}

describe('RFC-304 §4.2 — the verdict (pure)', () => {
  test('a conforming envelope yields the parsed value', () => {
    const v = judgeEnvelope({
      stdout: `noise\n${envelope(VALID)}\nmore noise`,
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(v.ok).toBe(true)
    expect(v.ok && v.value.findings[0]?.file).toBe('a.ts')
  })

  test('a missing envelope is rejected with instructions, not just a complaint', () => {
    const v = judgeEnvelope({
      stdout: 'I found some issues in the code!',
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.code).toBe('envelope-missing')
    // The model has to be told the exact shape, including the nonce it must use.
    expect(!v.ok && v.feedback).toContain(NONCE)
    expect(!v.ok && v.feedback).toContain(PORT)
  })

  test('an envelope with the WRONG nonce does not count', () => {
    // The nonce scopes the run; accepting a foreign one would let upstream
    // content forge an envelope.
    const v = judgeEnvelope({
      stdout: envelope(VALID, 'someone-elses-nonce'),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(!v.ok && v.code).toBe('envelope-missing')
  })

  test('unparsable JSON reports the parser’s own message', () => {
    const v = judgeEnvelope({
      stdout: envelope('{"findings": [},'),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(!v.ok && v.code).toBe('json-unparsable')
    // Without the position, a trailing comma in a long array is a hunt.
    expect(!v.ok && v.feedback.length).toBeGreaterThan(40)
  })

  test('a schema violation names the offending PATH, not just the rule', () => {
    const v = judgeEnvelope({
      stdout: envelope(
        JSON.stringify({ findings: [{ file: 'a.ts', line: -3, severity: 'nope', message: '' }] }),
      ),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(!v.ok && v.code).toBe('schema-invalid')
    // For an array of findings, "expected positive number" without a path is a
    // guessing game.
    expect(!v.ok && v.feedback).toContain('findings.0.line')
    expect(!v.ok && v.feedback).toContain('findings.0.severity')
  })

  test('semantic checks run only after the shape is known good', () => {
    const calls: unknown[] = []
    const v = judgeEnvelope({
      stdout: envelope('{"findings": "not-an-array"}'),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
      semanticCheck: (value) => {
        calls.push(value)
        return []
      },
    })
    expect(!v.ok && v.code).toBe('schema-invalid')
    // It must not have been handed a value that failed the schema.
    expect(calls).toEqual([])
  })

  test('a semantic rejection is distinguishable from a schema rejection', () => {
    const v = judgeEnvelope({
      stdout: envelope(VALID),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
      semanticCheck: (value) =>
        value.findings.some((f) => f.file.endsWith('.ts')) ? ['.ts files are out of scope'] : [],
    })
    expect(!v.ok && v.code).toBe('semantics-invalid')
    expect(!v.ok && v.feedback).toContain('out of scope')
  })

  test('an empty port is a rejection, not an empty result', () => {
    // "The model said nothing" and "the model said there is nothing" are
    // different answers; only the second is a valid empty findings list.
    const v = judgeEnvelope({
      stdout: `<workflow-output nonce="${NONCE}"><port name="${PORT}"></port></workflow-output>`,
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(!v.ok && v.code).toBe('port-missing')

    const explicitlyEmpty = judgeEnvelope({
      stdout: envelope('{"findings": []}'),
      nonce: NONCE,
      portName: PORT,
      schema: FindingsSchema,
    })
    expect(explicitlyEmpty.ok).toBe(true)
  })
})

describe('RFC-304 R4 — two retry levels, not one budget twice', () => {
  test('a first-attempt success calls once and carries no feedback', async () => {
    const { caller, seen } = scriptedCaller([envelope(VALID)])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 2, freshSession: 1 },
    })
    expect(out.status).toBe('ok')
    expect(out.totalCalls).toBe(1)
    expect(seen[0]).toMatchObject({ sessionId: null, feedback: null, rerunSeq: 0, attemptSeq: 0 })
  })

  test('a same-session retry continues the session AND carries the specific error', async () => {
    const { caller, seen } = scriptedCaller(['garbage', envelope(VALID)])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 2, freshSession: 1 },
    })

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.rerunSeq).toBe(0)
    expect(out.status === 'ok' && out.attemptSeq).toBe(1)
    // Continues the same session — that is the point of the cheap level: the
    // model still has the code it read in context.
    expect(seen[1]?.sessionId).toBe('session-1')
    expect(seen[1]?.feedback).toContain(NONCE)
  })

  test('exhausting same-session retries starts a FRESH session with no feedback', async () => {
    // The expensive level exists to escape a context that has gone wrong, so it
    // must drop BOTH the session and the correction. Carrying the feedback over
    // would describe a mistake made in a context this session never saw.
    const { caller, seen } = scriptedCaller(['bad', 'bad', 'bad', envelope(VALID)])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 2, freshSession: 1 },
    })

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.rerunSeq).toBe(1)
    expect(out.status === 'ok' && out.attemptSeq).toBe(0)
    // Calls 0,1,2 are session 1; call 3 opens a new one.
    expect(seen[3]?.sessionId).toBeNull()
    expect(seen[3]?.feedback).toBeNull()
  })

  test('both levels exhausted returns `exhausted` — never a best-effort value', async () => {
    // R5: there is no path out of here that hands downstream an unvalidated
    // value. A guard that "gave up and passed it through" would defeat the
    // entire constitution while looking more forgiving.
    const { caller } = scriptedCaller(['bad'])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 1, freshSession: 1 },
    })

    expect(out.status).toBe('exhausted')
    // (1 + sameSession) × (1 + freshSession) = 4
    expect(out.totalCalls).toBe(4)
    expect(out.status === 'exhausted' && out.rejections).toHaveLength(4)
    expect(out).not.toHaveProperty('value')
  })

  test('the rejection log records what the model kept doing', async () => {
    // Diagnosing "why did this stage fail" needs the sequence, not just the
    // last error: a model failing three different ways is a different problem
    // from one failing the same way three times.
    const { caller } = scriptedCaller(['no envelope', envelope('{bad json'), envelope('{}')])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 2, freshSession: 0 },
    })
    expect(out.status).toBe('exhausted')
    expect(out.status === 'exhausted' && out.rejections.map((r) => r.code)).toEqual([
      'envelope-missing',
      'json-unparsable',
      'schema-invalid',
    ])
  })

  test('a zero budget means exactly one attempt', async () => {
    const { caller } = scriptedCaller(['bad'])
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 0, freshSession: 0 },
    })
    expect(out.totalCalls).toBe(1)
    expect(out.status).toBe('exhausted')
  })
})

describe('RFC-304 T6 — transport failures and cancellation', () => {
  test('a throwing caller is retried, but the next attempt is NOT given feedback', async () => {
    // There was no output to critique. Telling the model to "fix" a network
    // error would spend its attention on a mistake it did not make.
    const seen: AiCallInput[] = []
    let calls = 0
    const caller: AiCaller = async (input) => {
      seen.push(input)
      calls++
      if (calls === 1) throw new Error('connection reset')
      return { stdout: envelope(VALID), sessionId: input.sessionId ?? 's1' }
    }
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 2, freshSession: 0 },
    })
    expect(out.status).toBe('ok')
    expect(seen[1]?.feedback).toBeNull()
  })

  test('an aborted signal stops before the next call', async () => {
    const controller = new AbortController()
    let calls = 0
    const caller: AiCaller = async () => {
      calls++
      controller.abort()
      return { stdout: 'bad', sessionId: 's1' }
    }
    const out = await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 5, freshSession: 5 },
      signal: controller.signal,
    })
    expect(out.status).toBe('canceled')
    expect(calls).toBe(1)
  })
})

describe('RFC-304 T2b — every AI call leaves an attempt record', () => {
  test('each attempt is claimed then settled, with its own seq pair', async () => {
    // AC-25 promises every AI call is inspectable. A stage row cannot express
    // "retried twice in-session, then re-ran fresh" — this pair of counters is
    // what makes that reconstructable.
    const claimed: Array<{ rerunSeq: number; attemptSeq: number }> = []
    const settled: Array<{ status: string; validationOutcome: string | null }> = []
    const recorder: AttemptRecorder = {
      claim: async (input) => {
        claimed.push(input)
        return `attempt-${claimed.length}`
      },
      settle: async (input) => {
        settled.push({ status: input.status, validationOutcome: input.validationOutcome })
      },
    }

    const { caller } = scriptedCaller(['bad', 'bad', envelope(VALID)])
    await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 1, freshSession: 1 },
      recorder,
    })

    expect(claimed).toEqual([
      { rerunSeq: 0, attemptSeq: 0 },
      { rerunSeq: 0, attemptSeq: 1 },
      { rerunSeq: 1, attemptSeq: 0 },
    ])
    expect(settled.map((s) => s.status)).toEqual(['failed', 'failed', 'validated'])
    // The failure reason is stored, so "why did this round take three calls"
    // is answerable from the table alone.
    expect(settled[0]?.validationOutcome).toBe('envelope-missing')
    expect(settled[2]?.validationOutcome).toBeNull()
  })

  test('a claimed attempt is settled even when the call throws', async () => {
    // Otherwise the row stays `claimed` forever and the recovery sweep cannot
    // tell a crashed daemon from an in-flight call.
    const settled: string[] = []
    const recorder: AttemptRecorder = {
      claim: async () => 'a1',
      settle: async (input) => {
        settled.push(input.status)
      },
    }
    const caller: AiCaller = async () => {
      throw new Error('boom')
    }
    await runGuardedAiStage({
      caller,
      schema: FindingsSchema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 0, freshSession: 0 },
      recorder,
    })
    expect(settled).toEqual(['failed'])
  })
})
