// RFC-224 T23 — permanent execution-identity failures must not consume a
// same-input retry or enter either normal-node/workgroup envelope follow-up.
//
// These pure routing checks cover every shared identity code, so extending the
// single-source vocabulary without updating backend behavior fails here.

import { EXECUTION_IDENTITY_FAILURE_CODES, FOLLOWUP_FAILURE_CODES } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideEnvelopeFollowup,
  shouldRetryNodeFailure,
  type PreviousAttemptShape,
} from '@/services/scheduler'
import {
  parseExecutionIdentityFailureLine,
  parseExecutionIdentityFailureOutput,
} from '@/services/runtime/opencode/failure'
import { followupForFailure } from '@/services/workgroup/engine'

const FOLLOWUP_BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  failureCode: 'envelope-missing',
  sessionId: 'session-owned-by-this-run',
  agentTextCount: 1,
}

describe('RFC-224 permanent failure routing', () => {
  test('every execution-identity code stops unchanged-input retries', () => {
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      expect(shouldRetryNodeFailure(code)).toBe(false)
    }
    for (const code of FOLLOWUP_FAILURE_CODES) {
      expect(shouldRetryNodeFailure(code)).toBe(true)
    }
    expect(shouldRetryNodeFailure(undefined)).toBe(true)
    expect(shouldRetryNodeFailure(null)).toBe(true)
  })

  test('normal-node follow-up rejects every identity code despite otherwise eligible shape', () => {
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      expect(decideEnvelopeFollowup({ ...FOLLOWUP_BASE, failureCode: code })).toEqual({
        followup: false,
      })
    }
  })

  test('workgroup protocol retries reject every identity code', () => {
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      expect(followupForFailure(code)).toEqual({ retry: false })
    }
  })

  test('the live scheduler loop consults the permanent predicate before minting another attempt', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(
      (source.match(/if \(!shouldRetryNodeFailure\(lastResult\.failureCode\)\) break/g) ?? [])
        .length,
    ).toBe(1)
  })

  test('verified launcher stderr exposes only the stable identity vocabulary', () => {
    for (const code of EXECUTION_IDENTITY_FAILURE_CODES) {
      const line = `AW_OPENCODE_FAILURE ${code}`
      expect(parseExecutionIdentityFailureLine(line)).toBe(code)
      expect(parseExecutionIdentityFailureOutput(`ordinary diagnostic\n${line}\n`)).toBe(code)
    }

    expect(parseExecutionIdentityFailureOutput('ordinary diagnostic only\n')).toBeNull()
    expect(
      parseExecutionIdentityFailureOutput('prefix AW_OPENCODE_FAILURE hidden in text\n'),
    ).toBeNull()
  })

  test('malformed, unknown, or duplicate launcher control lines fail closed', () => {
    expect(parseExecutionIdentityFailureOutput('AW_OPENCODE_FAILURE\n')).toBe(
      'execution-identity-mismatch',
    )
    expect(parseExecutionIdentityFailureOutput('AW_OPENCODE_FAILURE unknown-code\n')).toBe(
      'execution-identity-mismatch',
    )
    expect(parseExecutionIdentityFailureOutput('AW_OPENCODE_FAILURE malformed value\n')).toBe(
      'execution-identity-mismatch',
    )
    expect(
      parseExecutionIdentityFailureOutput(
        'AW_OPENCODE_FAILURE execution-identity-timeout\n' +
          'AW_OPENCODE_FAILURE execution-identity-timeout\n',
      ),
    ).toBe('execution-identity-mismatch')
  })
})
