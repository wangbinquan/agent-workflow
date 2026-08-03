/**
 * RFC-224 execution-identity failures are a closed, non-secret vocabulary
 * shared by save/probe/launch/UI and the runner retry policy. Most identify a
 * permanent contract mismatch; stream-failed is the deliberate exception
 * because a provider/SSE transport can disappear transiently after admission.
 */
export const EXECUTION_IDENTITY_FAILURE_CODES = [
  'execution-identity-untrusted-binary',
  'execution-identity-containment-required',
  /** Legacy read compatibility; new containment admission writes the code above. */
  'execution-identity-sandbox-required',
  'execution-identity-project-config-unsupported',
  'execution-identity-model-unresolved',
  'execution-identity-auth-invalid',
  'execution-identity-provider-untrusted',
  'execution-identity-bootstrap-failed',
  /**
   * RFC-251 note: this no longer means "the effective config differed from the
   * sealed one" — that attestation is gone. It now reports an INVALID INPUT to
   * the controlled-config builder / identity digest (hermetic.ts, and the
   * resume digest path), which is why it survives while
   * `execution-identity-instance-changed` did not.
   */
  'execution-identity-mismatch',
  'execution-identity-source-changed',
  'execution-identity-skill-mismatch',
  'execution-identity-session-mismatch',
  'execution-identity-session-owned',
  'execution-identity-control-failed',
  'execution-identity-stream-failed',
  'execution-identity-timeout',
  'execution-identity-store-unsafe',
] as const

export type ExecutionIdentityFailureCode = (typeof EXECUTION_IDENTITY_FAILURE_CODES)[number]

const EXECUTION_IDENTITY_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  EXECUTION_IDENTITY_FAILURE_CODES,
)

export function isExecutionIdentityFailureCode(
  value: unknown,
): value is ExecutionIdentityFailureCode {
  return typeof value === 'string' && EXECUTION_IDENTITY_FAILURE_CODE_SET.has(value)
}

/** Runtime liveness failed without proving that the frozen identity is invalid. */
export function isTransientRuntimeFailure(
  value: unknown,
): value is Extract<ExecutionIdentityFailureCode, 'execution-identity-stream-failed'> {
  return value === 'execution-identity-stream-failed'
}

/**
 * Permanent execution-identity failures must never enter same-input process
 * retry or envelope follow-up. A closed stream is transport/runtime liveness,
 * not proof that the frozen identity contract itself is invalid, so it may
 * consume the ordinary process-retry budget.
 */
export function isPermanentRuntimeFailure(value: unknown): boolean {
  return isExecutionIdentityFailureCode(value) && !isTransientRuntimeFailure(value)
}

export interface EffectiveExecutionPolicyInput {
  /** Resolved protocol, not the user-facing runtime row name. */
  protocol: string
  /** Resolved/frozen runtime model. */
  model: string | null | undefined
}

export interface ExecutionPolicyViolation {
  code: ExecutionIdentityFailureCode
  field: 'model'
}

/**
 * One pure policy table for every product boundary. Callers decide whether to
 * render, reject a save, or throw; they must not reimplement the conditions.
 *
 * RFC-251 removed the plugin and dependent-agent rules: both features are now
 * supported on the OpenCode path (assembled into the controlled config), so an
 * explicit model is the only remaining requirement.
 */
export function executionPolicyViolations(
  input: EffectiveExecutionPolicyInput,
): readonly ExecutionPolicyViolation[] {
  if (input.protocol !== 'opencode') return []
  const violations: ExecutionPolicyViolation[] = []
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    violations.push({ code: 'execution-identity-model-unresolved', field: 'model' })
  }
  return violations
}
