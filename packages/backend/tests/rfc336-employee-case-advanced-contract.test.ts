import { describe, expect, test } from 'bun:test'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  employeeWorkIntakeSchema,
  validateRepositoryBranchOption,
} from '@/modules/digital-employee/domain/runtimeModel'

const baseIntake = {
  name: 'RFC-336 advanced task',
  kind: 'body' as const,
  target: { repositoryId: 'repo-1' },
  body: 'Implement the approved task',
  externalId: null,
  uploads: [],
  executionOptions: {},
  idempotencyKey: 'rfc336-contract',
}

describe('RFC-336 digital employee advanced intake contract', () => {
  test('accepts four advanced values and rejects an auto-commit switch', () => {
    expect(
      employeeWorkIntakeSchema.parse({
        ...baseIntake,
        advanced: {
          collaboratorUserIds: ['user-1'],
          maxDurationMs: 60_000,
          maxTotalTokens: 20_000,
          typeOptions: { 'working-branch': 'feature/rfc336' },
        },
      }).advanced,
    ).toEqual({
      collaboratorUserIds: ['user-1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 20_000,
      typeOptions: { 'working-branch': 'feature/rfc336' },
    })
    expect(() =>
      employeeWorkIntakeSchema.parse({
        ...baseIntake,
        advanced: {
          collaboratorUserIds: [],
          typeOptions: {},
          autoCommitPush: false,
        },
      }),
    ).toThrow()
  })

  test('the development type declares a repository branch control', () => {
    const descriptor = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
      workIntakeAuthoring: {
        advancedOptions: Array<{
          optionRef: string
          control: string
          label: unknown
          description: unknown
        }>
      }
    }
    expect(descriptor.workIntakeAuthoring.advancedOptions).toEqual([
      {
        optionRef: 'working-branch',
        control: 'repository-branch',
        label: expect.any(Object),
        description: expect.any(Object),
      },
    ])
    expect(validateRepositoryBranchOption('feature/rfc336')).toBe(true)
    expect(validateRepositoryBranchOption('../main')).toBe(false)
  })
})
