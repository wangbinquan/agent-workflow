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
  'execution-identity-plugin-unsupported',
  'execution-identity-dependent-unsupported',
  'execution-identity-model-unresolved',
  'execution-identity-auth-invalid',
  'execution-identity-provider-untrusted',
  'execution-identity-bootstrap-failed',
  'execution-identity-mismatch',
  'execution-identity-instance-changed',
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
  enabledPluginCount?: number
  dependentAgentCount?: number
}

export interface ExecutionPolicyViolation {
  code: ExecutionIdentityFailureCode
  field: 'model' | 'plugins' | 'dependsOn'
}

/**
 * One pure policy table for every product boundary. Callers decide whether to
 * render, reject a save, or throw; they must not reimplement the conditions.
 */
export function executionPolicyViolations(
  input: EffectiveExecutionPolicyInput,
): readonly ExecutionPolicyViolation[] {
  if (input.protocol !== 'opencode') return []
  const violations: ExecutionPolicyViolation[] = []
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    violations.push({ code: 'execution-identity-model-unresolved', field: 'model' })
  }
  if ((input.enabledPluginCount ?? 0) > 0) {
    violations.push({ code: 'execution-identity-plugin-unsupported', field: 'plugins' })
  }
  if ((input.dependentAgentCount ?? 0) > 0) {
    violations.push({ code: 'execution-identity-dependent-unsupported', field: 'dependsOn' })
  }
  return violations
}
