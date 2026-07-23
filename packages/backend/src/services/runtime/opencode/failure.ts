import {
  isExecutionIdentityFailureCode,
  type ExecutionIdentityFailureCode,
} from '@agent-workflow/shared'

/**
 * A safe RFC-224 boundary error. Only the stable code and an optional JSON
 * Pointer are permitted in the message; values, credentials and host paths are
 * intentionally never accepted by the constructor.
 */
export class ExecutionIdentityFailure extends Error {
  readonly code: ExecutionIdentityFailureCode
  readonly pointer: string | null
  readonly permanent = true

  constructor(code: ExecutionIdentityFailureCode, pointer: string | null = null) {
    super(pointer === null || pointer === '' ? code : `${code} at ${pointer}`)
    this.name = 'ExecutionIdentityFailure'
    this.code = code
    this.pointer = pointer
  }
}

export function executionIdentityFailure(
  code: ExecutionIdentityFailureCode,
  pointer: string | null = null,
): never {
  throw new ExecutionIdentityFailure(code, pointer)
}

/**
 * Parse a launcher stderr control line without treating arbitrary model output
 * as policy. The launcher is the only writer of this exact prefix.
 */
export function parseExecutionIdentityFailureLine(
  line: string,
): ExecutionIdentityFailureCode | null {
  const match = /^AW_OPENCODE_FAILURE ([a-z0-9-]+)$/.exec(line)
  if (match === null) return null
  const code = match[1]
  return isExecutionIdentityFailureCode(code) ? code : null
}

/**
 * Parse the verified launcher's complete stderr after bounded drain. Ordinary
 * lines are ignored, but a malformed or duplicate control prefix fails closed
 * instead of allowing an attacker-controlled mock line to pick a code.
 */
export function parseExecutionIdentityFailureOutput(
  output: string,
): ExecutionIdentityFailureCode | null {
  let found: ExecutionIdentityFailureCode | null = null
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('AW_OPENCODE_FAILURE')) continue
    const parsed = parseExecutionIdentityFailureLine(line)
    if (parsed === null || found !== null) {
      return 'execution-identity-mismatch'
    }
    found = parsed
  }
  return found
}
