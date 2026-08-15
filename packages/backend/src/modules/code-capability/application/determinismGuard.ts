// RFC-304 T6 — the determinism guard: constitution R3/R4/R5 as executable code.
//
//   R3  every AI step declares an output schema, sealed in an envelope, and the
//       platform validates it BEFORE the next step.
//   R4  invalid → retry in the SAME session with the specific error, N times;
//       still invalid → drop the session and re-run in a FRESH one, M times.
//   R5  nothing downstream sees anything but a determinised value. There is no
//       "whatever the AI said" path out of this function.
//
// Why the two levels are different, and not just "retry N+M times": a
// same-session retry is cheap and keeps the context of the code the model has
// already read, so it fixes formatting slips and missed fields. A fresh session
// is what escapes a context that has gone wrong — a model that has convinced
// itself of a wrong frame will keep producing the same malformed answer no
// matter how many times you correct it in place. Collapsing the two would mean
// choosing one failure mode to be bad at.
//
// The guard emits an attempt record per call (`code_ai_attempts`, T2b) through
// an injected port. That is not bookkeeping for its own sake: AC-25 promises
// every AI call is inspectable, and a stage row cannot express "shard 2 retried
// twice, then re-ran in a new session".

import type { ZodType, ZodTypeDef } from 'zod'
import {
  judgeEnvelope,
  type EnvelopeRejectionCode,
} from '@/modules/code-capability/domain/envelopeVerdict'

export interface AiCallInput {
  /** Null starts a fresh session; a string continues that one. */
  sessionId: string | null
  /**
   * The previous rejection, verbatim, for a same-session retry. Null on the
   * first attempt of any session — a fresh session must not be told about
   * mistakes made in a context it cannot see.
   */
  feedback: string | null
  rerunSeq: number
  attemptSeq: number
}

export interface AiCallResult {
  stdout: string
  /** The native session id, so the next same-session retry continues it. */
  sessionId: string
}

export type AiCaller = (input: AiCallInput) => Promise<AiCallResult>

/** Persisted per attempt (`code_ai_attempts`). Injected so the guard stays testable. */
export interface AttemptRecorder {
  /** Called before the AI runs; returns the row id used to settle it. */
  claim(input: { rerunSeq: number; attemptSeq: number }): Promise<string>
  settle(input: {
    attemptId: string
    status: 'validated' | 'failed'
    validationOutcome: string | null
    sessionRef: string | null
  }): Promise<void>
}

export interface RetryBudget {
  /** Same-session retries AFTER the first attempt (design R4's N). */
  sameSession: number
  /** Fresh-session re-runs AFTER the first session (design R4's M). */
  freshSession: number
}

export interface GuardedAiStageArgs<T> {
  caller: AiCaller
  /** See `JudgeEnvelopeArgs.schema` — the input side is `unknown` by design. */
  schema: ZodType<T, ZodTypeDef, unknown>
  nonce: string
  portName: string
  budget: RetryBudget
  semanticCheck?: (value: T) => readonly string[]
  recorder?: AttemptRecorder
  signal?: AbortSignal
}

export type GuardedAiOutcome<T> =
  | { status: 'ok'; value: T; rerunSeq: number; attemptSeq: number; totalCalls: number }
  | {
      status: 'exhausted'
      /** Every rejection, in order — the record of what the model kept doing. */
      rejections: Array<{
        rerunSeq: number
        attemptSeq: number
        code: EnvelopeRejectionCode
        feedback: string
      }>
      totalCalls: number
    }
  | { status: 'canceled'; totalCalls: number }

export async function runGuardedAiStage<T>(
  args: GuardedAiStageArgs<T>,
): Promise<GuardedAiOutcome<T>> {
  const rejections: Array<{
    rerunSeq: number
    attemptSeq: number
    code: EnvelopeRejectionCode
    feedback: string
  }> = []
  let totalCalls = 0

  for (let rerunSeq = 0; rerunSeq <= args.budget.freshSession; rerunSeq++) {
    // A fresh session starts with no session id AND no feedback: carrying the
    // correction across would describe a mistake made in a context this session
    // never saw, which reads as an instruction about nothing.
    let sessionId: string | null = null
    let feedback: string | null = null

    for (let attemptSeq = 0; attemptSeq <= args.budget.sameSession; attemptSeq++) {
      if (args.signal?.aborted === true) return { status: 'canceled', totalCalls }

      const attemptId = await args.recorder?.claim({ rerunSeq, attemptSeq })
      totalCalls++

      let result: AiCallResult
      try {
        result = await args.caller({ sessionId, feedback, rerunSeq, attemptSeq })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (attemptId !== undefined) {
          await args.recorder?.settle({
            attemptId,
            status: 'failed',
            validationOutcome: `call-failed: ${message}`,
            sessionRef: sessionId,
          })
        }
        // A transport failure is not a validation failure — there is no output
        // to give feedback about, so the next attempt starts clean rather than
        // telling the model to fix an error it did not make.
        rejections.push({ rerunSeq, attemptSeq, code: 'envelope-missing', feedback: message })
        feedback = null
        continue
      }

      sessionId = result.sessionId
      const verdict = judgeEnvelope({
        stdout: result.stdout,
        nonce: args.nonce,
        portName: args.portName,
        schema: args.schema,
        ...(args.semanticCheck !== undefined ? { semanticCheck: args.semanticCheck } : {}),
      })

      if (attemptId !== undefined) {
        await args.recorder?.settle({
          attemptId,
          status: verdict.ok ? 'validated' : 'failed',
          validationOutcome: verdict.ok ? null : verdict.code,
          sessionRef: sessionId,
        })
      }

      if (verdict.ok) {
        return { status: 'ok', value: verdict.value, rerunSeq, attemptSeq, totalCalls }
      }
      rejections.push({ rerunSeq, attemptSeq, code: verdict.code, feedback: verdict.feedback })
      feedback = verdict.feedback
    }
  }

  return { status: 'exhausted', rejections, totalCalls }
}
