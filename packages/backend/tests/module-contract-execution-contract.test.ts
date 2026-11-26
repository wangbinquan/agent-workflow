// Module contract audit: exercise the composition handle, including batch work bounds,
// missing revisions, mechanism failure receipts, and input/output pairing.
import { describe, expect, test } from 'bun:test'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import type { ExecutionContractResourcePort } from '@/modules/execution-contract/composition/required-ports'
import type { ExecutionContractRegistration } from '@/modules/execution-contract/public/types'
import { developmentExecutionContractRegistrations } from '@/modules/development-automation/composition/employeeTypePackage'

const registration = developmentExecutionContractRegistrations.find(
  (candidate) => candidate.contractRef.contractId === 'development.analyze-implement',
)!
const ref = registration.contractRef

function contract(resources: ExecutionContractResourcePort, registrations = [registration]) {
  return composeExecutionContract({
    registrations,
    resources,
    programFixtures: {
      async run() {
        throw new Error('agent validation must not execute a program fixture')
      },
    },
  })
}

describe('module contract: execution-contract', () => {
  test('candidate batches inspect each exact revision once and preserve independent invalid receipts', async () => {
    const inspected: string[] = []
    const participant = contract({
      async inspect({ implementation, expectedOutputPort }) {
        if (implementation.kind !== 'agent') throw new Error('expected an agent candidate')
        const { id, revision } = implementation.agentRef
        inspected.push(`${id}@${revision}`)
        expect(expectedOutputPort).toBe('agent-result')
        if (revision === 2) return null
        return {
          kind: 'agent',
          name: id,
          available: true,
          detail: 'exact revision resolved',
          declaredContractRefs: id === 'declared' ? [ref] : [],
        }
      },
    })
    const requested = [
      { id: 'declared', revision: 1 },
      { id: 'declared', revision: 2 },
      { id: 'undeclared', revision: 1 },
    ]
    const results = await participant.validateAgentCandidates({
      contractRef: ref,
      agentRefs: Array.from({ length: 150 }, (_, index) => requested[index % 3]!),
    })
    expect(inspected).toEqual(['declared@1', 'declared@2', 'undeclared@1'])
    expect(results.map((result) => result.agentRef)).toEqual(requested)
    expect(results.map((result) => result.validationReceipt.status)).toEqual([
      'valid',
      'invalid',
      'invalid',
    ])
    expect(results[1]?.validationReceipt.checks).toContainEqual(
      expect.objectContaining({ code: 'agent-exact-revision-resolves', ok: false }),
    )
    expect(results[2]?.validationReceipt.checks).toContainEqual(
      expect.objectContaining({ code: 'agent-contract-declared', ok: false }),
    )
  })

  test('an empty candidate batch performs no resource lookup, but still requires a registered contract', async () => {
    let calls = 0
    const participant = contract({
      async inspect() {
        calls += 1
        return null
      },
    })
    expect(await participant.validateAgentCandidates({ contractRef: ref, agentRefs: [] })).toEqual(
      [],
    )
    await expect(
      participant.validateAgentCandidates({
        contractRef: { contractId: ref.contractId, version: 999_999 },
        agentRefs: [],
      }),
    ).rejects.toMatchObject({ code: 'execution-contract-not-found' })
    expect(calls).toBe(0)
  })

  test('resource inspection failures remain failures and the next request can succeed', async () => {
    const unavailable = new Error('resource-reader-unavailable')
    let fail = true
    const participant = contract({
      async inspect() {
        if (fail) throw unavailable
        return {
          kind: 'agent',
          name: 'recovered',
          available: true,
          detail: 'reader recovered',
          declaredContractRefs: [ref],
        }
      },
    })
    const request = { contractRef: ref, agentRefs: [{ id: 'recovered', revision: 1 }] }
    await expect(participant.validateAgentCandidates(request)).rejects.toBe(unavailable)
    fail = false
    expect((await participant.validateAgentCandidates(request))[0]?.validationReceipt.status).toBe(
      'valid',
    )
  })

  test('registration ambiguity is rejected before any executor or resource is touched', () => {
    let calls = 0
    const resources = {
      async inspect() {
        calls += 1
        return null
      },
    }
    expect(() => contract(resources, [registration, registration])).toThrow(
      'development.analyze-implement',
    )
    const mismatched: ExecutionContractRegistration = {
      ...registration,
      contractRef: { ...ref, version: ref.version + 100 },
    }
    expect(() => contract(resources, [mismatched])).toThrow('!=')
    expect(calls).toBe(0)
  })

  test('the composed program validator preserves a failed mechanism receipt without accepting output', async () => {
    const program = developmentExecutionContractRegistrations.find(
      (candidate) => candidate.contractRef.contractId === 'development.prepare-materials',
    )!
    let executions = 0
    const participant = composeExecutionContract({
      registrations: [program],
      resources: {
        async inspect() {
          throw new Error('program validation must not inspect an Agent')
        },
      },
      programFixtures: {
        async run({ inputJson }) {
          executions += 1
          expect(JSON.parse(inputJson)).toMatchObject({
            roundRef: expect.any(String),
            executionNonce: expect.any(String),
          })
          return {
            kind: 'failed',
            checks: [{ code: 'program-fixture-execution', ok: false, detail: 'process exited 23' }],
          }
        },
      },
    })
    const receipt = await participant.validateExecutor({
      contractRef: program.contractRef,
      implementation: {
        kind: 'program',
        runtimeKind: 'node',
        executableArtifactRef: 'fixture.js',
        executableDigest: 'a'.repeat(64),
        parameterValuesRef: null,
        runtimeProfileRef: { id: 'fixture-profile', revision: 1 },
      },
    })
    expect(receipt.status).toBe('invalid')
    expect(receipt.checks).toContainEqual({
      code: 'program-fixture-execution',
      ok: false,
      detail: 'process exited 23',
    })
    expect(executions).toBe(1)
  })
})
