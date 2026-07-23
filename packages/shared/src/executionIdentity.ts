/**
 * RFC-224 execution-identity failures are permanent for an unchanged runtime
 * selection. They are deliberately a closed, non-secret vocabulary shared by
 * save/probe/launch/UI and the runner retry policy.
 */
export const EXECUTION_IDENTITY_FAILURE_CODES = [
  'execution-identity-untrusted-binary',
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

/**
 * These failures must never enter same-input process retry or envelope
 * follow-up. The operator must change the runtime/config/source contract.
 */
export function isPermanentRuntimeFailure(value: unknown): boolean {
  return isExecutionIdentityFailureCode(value)
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
