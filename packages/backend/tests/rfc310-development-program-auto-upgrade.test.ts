import { describe, expect, test } from 'bun:test'

import { upgradeLegacyDevelopmentProgram } from '@/modules/development-automation/composition/legacyDevelopmentProgramUpgrade'

const executionEnv = (input: unknown, taskId = 'real-digital-employee-task') =>
  Object.fromEntries(
    Object.entries({
      ...process.env,
      AW_TASK_ID: taskId,
      AW_NODE_RUN_ID: 'compatibility-round',
      AW_PORT_CONTRACT_INPUT: JSON.stringify(input),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

function runProgram(source: string, input: unknown, taskId?: string): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--input-type=module', '--eval', source],
    env: executionEnv(input, taskId),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>
}

function upgrade(input: { sourceContractId: string; targetContractId: string; source: string }) {
  const targetVersion = input.targetContractId === 'development.prepare-materials' ? 3 : 2
  return upgradeLegacyDevelopmentProgram({
    sourceContract: { contractId: input.sourceContractId, version: 1 },
    targetContract: { contractId: input.targetContractId, version: targetVersion },
    implementation: { kind: 'program', runtimeKind: 'node' },
    source: input.source,
  })
}

describe('RFC-310 development program automatic compatibility upgrade', () => {
  test('adapts a legacy material program to the standard v3 input and output', () => {
    const migrated = upgrade({
      sourceContractId: 'development.prepare-materials',
      targetContractId: 'development.prepare-materials',
      source: `
        const input = JSON.parse(process.env.AW_PORT_CONTRACT_INPUT ?? '{}')
        const request = input.contractInput?.workRequest
        if (request?.kind !== 'external-id' || request.externalId !== 'ISSUE-42') {
          throw new Error('legacy material input was not projected')
        }
        process.stdout.write(JSON.stringify({
          schemaVersion: 1,
          roundRef: input.roundRef,
          executionNonce: input.executionNonce,
          status: 'ok',
          summary: 'legacy material acquired',
          contextPatches: [],
          effectSuggestions: [],
          artifactRefs: [],
        }))
      `,
    })

    expect(migrated?.runtimeKind).toBe('node')
    expect(
      runProgram(migrated!.source, {
        workRequest: {
          kind: 'external-id',
          body: null,
          externalId: 'ISSUE-42',
          uploads: [],
        },
        outputDirectory: '.agent-workflow/inputs/requirements/case/external',
      }),
    ).toEqual({ outcome: 'completed', explanation: 'legacy material acquired' })
  })

  test('adapts a legacy approval program and produces a current-version draft', () => {
    const migrated = upgrade({
      sourceContractId: 'development.prepare-approval',
      targetContractId: 'development.draft-approval',
      source: `
        const input = JSON.parse(process.env.AW_PORT_CONTRACT_INPUT ?? '{}')
        const mr = input.contractInput?.mergeRequest
        if (mr?.mergeRequestRef !== 'project!17' || mr.headSha !== '${'a'.repeat(40)}') {
          throw new Error('legacy approval input was not projected')
        }
        process.stdout.write(JSON.stringify({
          schemaVersion: 1,
          roundRef: input.roundRef,
          executionNonce: input.executionNonce,
          status: 'ok',
          summary: 'legacy approval prepared',
          contextPatches: [],
          effectSuggestions: [],
          artifactRefs: [],
        }))
      `,
    })

    expect(migrated?.runtimeKind).toBe('node')
    const result = runProgram(migrated!.source, {
      mergeRequest: 'project!17',
      currentVersion: 'a'.repeat(40),
      approvalType: 'gate-change',
      gateConclusions: [{ name: 'pipeline', conclusion: 'passed' }],
      formatGuide: 'Use Markdown.',
    })
    expect(result.outcome).toBe('completed')
    expect(result.explanation).toBe('legacy approval prepared')
    expect(result.draft).toContain('project!17')
    expect(result.draft).toContain('pipeline: passed')
  })

  test('uses a side-effect-free fixture result while still rejecting unsupported transitions', () => {
    const migrated = upgrade({
      sourceContractId: 'development.prepare-materials',
      targetContractId: 'development.prepare-materials',
      source: `throw new Error('the legacy implementation must not run in the contract fixture')`,
    })
    expect(
      runProgram(
        migrated!.source,
        {
          workRequest: {
            kind: 'external-id',
            body: null,
            externalId: 'ISSUE-42',
            uploads: [],
          },
          outputDirectory: '.agent-workflow/inputs/requirements/case/external',
        },
        'execution-contract-fixture',
      ),
    ).toEqual({ outcome: 'completed' })

    expect(
      upgrade({
        sourceContractId: 'development.implement-change',
        targetContractId: 'development.implement-change',
        source: 'process.stdout.write("{}")',
      }),
    ).toBeNull()
  })
})
