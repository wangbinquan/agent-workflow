import { describe, expect, test } from 'bun:test'

import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
} from '../src/modules/development-automation/composition/employeeTypePackage'
import { ExecutionContractService } from '../src/modules/execution-contract/application/executionContractService'

describe('digital employee conflict repair instructions', () => {
  test('freeze writes to unresolved paths and preserve automatic merge results', () => {
    const envelope = JSON.parse(
      developmentEmployeeRuntimeCodec.assembleReactionInputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: { typeId: 'development', revision: 8 },
          caseRef: 'case-conflict-instructions',
          roundRef: 'round-conflict-instructions',
          executionNonce: 'a'.repeat(64),
          workItemRef: 'repair-conflict',
          toolSlotRef: 'default',
          connectionRef: null,
          inputSchemaId: 'development.conflict-context.v1',
          outputSchemaId: 'development.change-proposal.v1',
          eventJson: JSON.stringify({ kind: 'work-item-continuation' }),
          contextsJson: '[]',
          orderedDispatchConfigurationsJson: '[]',
          toolBindingsJson: '[]',
        }),
      ),
    ) as {
      roundRef: string
      executionNonce: string
      contractInput: { event: Record<string, unknown> }
      workInstructions: string
    }

    const registration = developmentExecutionContractRegistrations.find(
      (candidate) =>
        candidate.contractRef.contractId === 'development.repair-conflict' &&
        candidate.contractRef.version === 1,
    )
    expect(registration?.projectInputJson).toBeFunction()
    const contracts = new ExecutionContractService({
      registrations: developmentExecutionContractRegistrations,
      resources: { inspect: async () => null },
      programFixtures: { validate: async () => [] },
    })
    const projected = JSON.parse(
      contracts.projectInput({
        contractRef: { contractId: 'development.repair-conflict', version: 1 },
        roundRef: envelope.roundRef,
        executionNonce: envelope.executionNonce,
        inputEnvelopeJson: JSON.stringify(envelope),
        projectionJson: JSON.stringify({ conflictFiles: ['dependency/READY.md'] }),
      }),
    ) as typeof envelope

    expect(projected.contractInput.event).toMatchObject({
      kind: 'work-item-continuation',
      conflictFiles: ['dependency/READY.md'],
    })
    expect(projected.workInstructions).toContain('contractInput.event.conflictFiles')
    expect(projected.workInstructions).toContain('does not preserve the merge index')
    expect(projected.workInstructions).toContain('do not rewrite, restore, format')
    expect(projected.workInstructions).not.toContain('git diff --name-only --diff-filter=U')
  })
})
