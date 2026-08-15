// RFC-304 T6 (domain half) — is this AI output usable, and if not, what do we
// tell the model?
//
// Pure by design. The interesting part of the determinism guard is not the
// retry loop, it is the JUDGEMENT: what counts as a validation failure, and
// what the feedback says. Keeping that a function of (stdout, schema) means
// every verdict is testable without a model, a session or a subprocess.
//
// The boundary that took a design gate to get right (design §4.2):
//
//   "the AI said something WRONG"      → validation failure → retry (R4)
//   "the AI said something ELSEWHERE"  → anchoring failure  → NOT retried
//
// A finding whose line is not inside the diff's hunks is not malformed — the
// remark may well be correct, it just cannot be attached to a line. Retrying
// would not improve it, and treating it as a failure would push a correct
// finding into the same terminal state as garbage. So anchoring lives in the
// `resolve-positions` stage and never reaches this module; what arrives here is
// only ever "does the output conform to what the stage declared".

import type { ZodType, ZodTypeDef } from 'zod'
import { extractLastEnvelope, parseEnvelope } from '@/services/envelope'

export type EnvelopeVerdict<T> =
  | { ok: true; value: T }
  /**
   * `feedback` goes back to the model verbatim on the next same-session
   * attempt, so it must be actionable: which field, what was wrong, what was
   * expected. "Invalid output" teaches the model nothing and burns an attempt.
   */
  | { ok: false; code: EnvelopeRejectionCode; feedback: string }

export type EnvelopeRejectionCode =
  | 'envelope-missing'
  | 'port-missing'
  | 'json-unparsable'
  | 'schema-invalid'
  | 'semantics-invalid'

export interface JudgeEnvelopeArgs<T> {
  stdout: string
  /** The nonce scoping this run's envelope — the same one scripts and agents use. */
  nonce: string
  /** Which port inside the envelope carries the payload. */
  portName: string
  /**
   * The input side is `unknown` on purpose: what arrives is `JSON.parse` output,
   * and typing it as the schema's own input type would reject any schema whose
   * input differs from its output — every schema with a `.default()`, which is
   * exactly how an optional field with a sensible fallback is declared.
   */
  schema: ZodType<T, ZodTypeDef, unknown>
  /**
   * Closed-set / range checks the schema cannot express, returning one message
   * per problem. Runs only after the schema passes, so it can assume the shape.
   */
  semanticCheck?: (value: T) => readonly string[]
}

export function judgeEnvelope<T>(args: JudgeEnvelopeArgs<T>): EnvelopeVerdict<T> {
  const envelope = extractLastEnvelope(args.stdout, args.nonce)
  if (envelope === null) {
    return {
      ok: false,
      code: 'envelope-missing',
      feedback: `No <workflow-output nonce="${args.nonce}"> block was found in your reply. Emit exactly one, containing a <port name="${args.portName}"> element.`,
    }
  }

  const parsed = parseEnvelope(envelope, [args.portName], args.nonce)
  const raw = parsed.ports.get(args.portName)
  if (raw === undefined || raw === '') {
    return {
      ok: false,
      code: 'port-missing',
      feedback: `The envelope did not contain a non-empty <port name="${args.portName}">.`,
    }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      code: 'json-unparsable',
      // Include the parser's own message: "unexpected token at position 412"
      // is what lets the model find its own trailing comma.
      feedback: `The <port name="${args.portName}"> content is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const result = args.schema.safeParse(json)
  if (!result.success) {
    return {
      ok: false,
      code: 'schema-invalid',
      feedback: `The output does not match the required schema:\n${formatZodIssues(result.error)}`,
    }
  }

  const problems = args.semanticCheck?.(result.data) ?? []
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'semantics-invalid',
      feedback: `The output is well-formed but not valid:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    }
  }

  return { ok: true, value: result.data }
}

/**
 * One line per issue, each naming its path. Zod's default `message` alone omits
 * WHERE the problem is, which for an array of findings is the difference
 * between a fixable instruction and a guessing game.
 */
function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
      return `- ${path}: ${issue.message}`
    })
    .join('\n')
}
