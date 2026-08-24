// RFC-318 real GitLab regression (2026-08-25): valid repair-conflict and
// repair-feedback runs returned a useful top-level explanation together with
// outcome=completed. The authored guide exposed that field, but every strict
// completed-result schema rejected it and forced a redundant Agent retry.

import { describe, expect, test } from 'bun:test'

import {
  validateDevelopmentToolOutputV2,
  type DevelopmentToolJsonOutputContractIdV2,
} from '@/modules/development-automation/domain/digitalEmployeeToolContractsV2'

const completedOutputs = {
  'development.prepare-materials': { outcome: 'completed' },
  'development.implement-change': {
    outcome: 'completed',
    commitMessage: 'implement requested behavior',
    mergeRequestTitle: 'Implement requested behavior',
    mergeRequestDescription: 'Implemented the requested behavior and regression coverage.',
  },
  'development.resolve-review-feedback': {
    outcome: 'completed',
    replies: [{ threadRef: 'thread-1', reply: 'Added the focused regression coverage.' }],
    commitMessage: 'address review feedback',
  },
  'development.collect-pipeline-status': {
    outcome: 'completed',
    observedSourceVersion: 'source-sha',
    observedTargetVersion: 'target-sha',
    status: 'passed',
    checks: [{ checkRef: 'test', name: 'Test', status: 'passed' }],
  },
  'development.classify-pipeline-failures': {
    outcome: 'completed',
    groups: [{ type: 'test-failure', checkRefs: ['test'] }],
  },
  'development.repair-pipeline-failures': {
    outcome: 'completed',
    commitMessage: 'repair failing pipeline',
  },
  'development.resolve-merge-conflicts': {
    outcome: 'completed',
    commitMessage: 'resolve merge conflict',
  },
  'development.draft-approval': {
    outcome: 'completed',
    draft: 'Approve the current merge request after all gates passed.',
  },
} as const satisfies Record<DevelopmentToolJsonOutputContractIdV2, Record<string, unknown>>

describe('RFC-318 completed-result explanation compatibility', () => {
  test('every direct JSON action accepts a non-empty optional completion explanation', () => {
    for (const [contractId, output] of Object.entries(completedOutputs) as Array<
      [DevelopmentToolJsonOutputContractIdV2, Record<string, unknown>]
    >) {
      expect(
        JSON.parse(
          validateDevelopmentToolOutputV2(
            contractId,
            JSON.stringify({ ...output, explanation: 'Completed and verified the assigned work.' }),
          ),
        ),
      ).toEqual({ ...output, explanation: 'Completed and verified the assigned work.' })
    }
  })

  test('compatibility remains strict for empty explanations and unknown fields', () => {
    for (const [contractId, output] of Object.entries(completedOutputs) as Array<
      [DevelopmentToolJsonOutputContractIdV2, Record<string, unknown>]
    >) {
      expect(() =>
        validateDevelopmentToolOutputV2(
          contractId,
          JSON.stringify({ ...output, explanation: '   ' }),
        ),
      ).toThrow()
      expect(() =>
        validateDevelopmentToolOutputV2(
          contractId,
          JSON.stringify({ ...output, schemaVersion: 2 }),
        ),
      ).toThrow()
    }
  })
})
