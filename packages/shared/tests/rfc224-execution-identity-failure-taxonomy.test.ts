// RFC-224 T23 — execution-identity failure taxonomy and follow-up separation.
//
// Why this test exists: task failure codes historically were identical to the
// seven envelope mistakes and every code therefore implied a corrective model
// re-prompt. RFC-224 adds permanent runtime identity failures. This oracle
// locks the identity leaf as the single vocabulary source, the complete DTO
// union as a lossless composition, and the crucial fact that none of those
// permanent failures enters the envelope follow-up table.

import { describe, expect, test } from 'bun:test'
import {
  EXECUTION_IDENTITY_FAILURE_CODES,
  FAILURE_CODES,
  FOLLOWUP_FAILURE_CODES,
  FailureCodeSchema,
  FOLLOWUP_POLICY,
  followupPolicyForFailure,
  isExecutionIdentityFailureCode,
  isPermanentRuntimeFailure,
} from '../src'

describe('RFC-224 execution identity failure taxonomy', () => {
  test('identity vocabulary is closed, unique, and composed into the task failure union once', () => {
    expect(EXECUTION_IDENTITY_FAILURE_CODES).toEqual([
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
    ])
    expect(new Set(EXECUTION_IDENTITY_FAILURE_CODES).size).toBe(
      EXECUTION_IDENTITY_FAILURE_CODES.length,
    )
    expect(FAILURE_CODES).toEqual([...FOLLOWUP_FAILURE_CODES, ...EXECUTION_IDENTITY_FAILURE_CODES])
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length)
  })

  test('schema and guards accept every identity code and reject lookalikes', () => {
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      expect(FailureCodeSchema.parse(code)).toBe(code)
      expect(isExecutionIdentityFailureCode(code)).toBe(true)
      expect(isPermanentRuntimeFailure(code)).toBe(true)
    }
    for (const value of [
      'execution-identity',
      'execution-identity-mismatch-extra',
      'envelope-missing',
      '',
      null,
      1,
    ]) {
      expect(isExecutionIdentityFailureCode(value)).toBe(false)
      expect(isPermanentRuntimeFailure(value)).toBe(false)
    }
  })

  test('follow-up stays a narrow envelope-only policy', () => {
    expect(Object.keys(FOLLOWUP_POLICY).sort()).toEqual([...FOLLOWUP_FAILURE_CODES].sort())
    for (const code of FOLLOWUP_FAILURE_CODES) {
      expect(followupPolicyForFailure(code)).toEqual(FOLLOWUP_POLICY[code])
    }
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      expect(followupPolicyForFailure(code)).toBeUndefined()
    }
    expect(followupPolicyForFailure(undefined)).toBeUndefined()
    expect(followupPolicyForFailure(null)).toBeUndefined()
  })
})
