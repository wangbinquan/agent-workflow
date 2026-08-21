import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { agents as agentRows } from '@/db/schema'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import {
  createExecutionContractProgramFixtureAdapter,
  createExecutionContractResourceAdapter,
} from '@/modules/execution-contract/infrastructure/taskExecutionAdapter'
import {
  executionContractGuideSchema,
  validateExactContractInput,
  validateExactContractOutput,
} from '@/modules/execution-contract/domain/model'
import { executionContractRefKey } from '@/modules/execution-contract/public/types'
import { createProgramArtifactStore } from '@/modules/digital-employee/infrastructure/programArtifactStore'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { synthesizeDigitalEmployeeScriptHostSnapshot } from '@/modules/task-execution/domain/digitalEmployeeHost'
import { createAgent, updateAgent } from '@/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function guide(contractId: string) {
  const registration = developmentExecutionContractRegistrations.find(
    (candidate) => candidate.contractRef.contractId === contractId,
  )
  if (registration === undefined) throw new Error(`missing fixture ${contractId}`)
  return executionContractGuideSchema.parse(JSON.parse(registration.guideJson) as unknown)
}

describe('platform execution contracts', () => {
  test('the guide exposes direct external-id injection and the exact script transport', () => {
    const material = guide('development.prepare-materials')
    expect(material.input.fields.map((field) => field.path)).toContain(
      'contractInput.workRequest.externalId',
    )
    expect(
      material.input.topLevelFields.every((field) =>
        material.input.fields.some((guideField) => guideField.path === field),
      ),
    ).toBe(true)
    expect(material.transports.program?.inputLocation).toContain('AW_PORT_CONTRACT_INPUT')
    expect(material.transports.program?.inputLocation).toContain('AW_PORT_FILE_CONTRACT_INPUT')
    expect(material.output.topLevelFields).toEqual([
      'schemaVersion',
      'roundRef',
      'executionNonce',
      'status',
      'summary',
      'contextPatches',
      'effectSuggestions',
      'artifactRefs',
    ])
  })

  test('contract registration rejects guides whose examples or executor kinds contradict the guide', () => {
    const mismatchedExample = structuredClone(guide('development.prepare-materials'))
    mismatchedExample.input.exampleJson = JSON.stringify({ unexpected: true })
    expect(executionContractGuideSchema.safeParse(mismatchedExample).success).toBe(false)

    const duplicateExecutor = structuredClone(guide('development.prepare-materials'))
    duplicateExecutor.allowedExecutorKinds.push('agent')
    expect(executionContractGuideSchema.safeParse(duplicateExecutor).success).toBe(false)
  })

  test('the type package projects an intake ID into a directly consumable contractInput', () => {
    const envelope = JSON.parse(
      developmentEmployeeRuntimeCodec.assembleReactionInputJson(
        JSON.stringify({
          schemaVersion: 1,
          roundRef: 'round-1',
          executionNonce: '1'.repeat(64),
          workItemRef: 'prepare-materials',
          toolSlotRef: 'default',
          connectionRef: null,
          inputSchemaId: 'development.work-request.v1',
          outputSchemaId: 'development.requirement-context.v1',
          eventJson: JSON.stringify({ eventTypeId: 'development.work-received' }),
          contextsJson: JSON.stringify([
            {
              typeId: 'development.issue-handling',
              schemaVersion: 1,
              revision: 1,
              stateJson: JSON.stringify({
                status: 'active',
                subjectRef: 'repo:ISSUE-1234',
                repositoryRef: 'repo',
                request: {
                  kind: 'external-id',
                  body: null,
                  externalId: 'ISSUE-1234',
                  uploads: [],
                },
                materialArtifactRefs: [],
              }),
              artifactRefs: [],
            },
          ]),
        }),
      ),
    ) as Record<string, unknown>
    expect(envelope.contractInput).toEqual({
      workRequest: {
        kind: 'external-id',
        body: null,
        externalId: 'ISSUE-1234',
        uploads: [],
      },
      repositoryRef: 'repo',
    })
  })

  test('exact envelope validation rejects malformed input and missing, extra, or cross-round output', () => {
    const contract = guide('development.analyze-implement')
    const exactInput = JSON.parse(contract.input.exampleJson) as Record<string, unknown>
    exactInput.roundRef = 'round-1'
    exactInput.executionNonce = '2'.repeat(64)
    expect(
      JSON.parse(
        validateExactContractInput({
          guide: contract,
          roundRef: 'round-1',
          executionNonce: '2'.repeat(64),
          inputJson: JSON.stringify(exactInput),
        }),
      ),
    ).toEqual(exactInput)
    expect(() =>
      validateExactContractInput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        inputJson: JSON.stringify({ ...exactInput, workItemRef: 42 }),
      }),
    ).toThrow('workItemRef must be string')

    const base = {
      schemaVersion: 1,
      roundRef: 'round-1',
      executionNonce: '2'.repeat(64),
      status: 'ok',
      summary: 'done',
      contextPatches: [],
      effectSuggestions: [],
      artifactRefs: [],
    }
    expect(
      JSON.parse(
        validateExactContractOutput({
          guide: contract,
          roundRef: 'round-1',
          executionNonce: '2'.repeat(64),
          outputJson: JSON.stringify(base),
        }),
      ),
    ).toEqual(base)
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify({ ...base, extra: true }),
      }),
    ).toThrow('extra=[extra]')
    const missing: Partial<typeof base> = { ...base }
    delete missing.summary
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify(missing),
      }),
    ).toThrow('missing=[summary]')
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'round-1',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify({ ...base, contextPatches: 'not-an-array' }),
      }),
    ).toThrow('contextPatches must be array')
    expect(() =>
      validateExactContractOutput({
        guide: contract,
        roundRef: 'other-round',
        executionNonce: '2'.repeat(64),
        outputJson: JSON.stringify(base),
      }),
    ).toThrow('roundRef')
  })

  test('Agent compatibility requires both the output port and an explicit contract declaration', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await ensureDigitalEmployeeAgentTemplates(db)
    const templates = await listDigitalEmployeeAgentTemplates(db)
    const codeWriter = templates.find(
      (agent) => agent.frontmatterExtra.digitalEmployeeTemplate === 'code-writing',
    )!
    db.update(agentRows)
      .set({
        frontmatterExtra: JSON.stringify({
          digitalEmployeeTemplate: 'code-writing',
          schemaVersion: 1,
        }),
      })
      .where(eq(agentRows.id, codeWriter.id))
      .run()
    const service = new ExecutionContractService({
      registrations: developmentExecutionContractRegistrations,
      resources: createExecutionContractResourceAdapter(
        db,
        developmentImplicitAgentContractDeclarations,
      ),
      programFixtures: {
        async validate() {
          return []
        },
      },
    })
    const compatible = await service.validateExecutor({
      contractRef: { contractId: 'development.analyze-implement', version: 1 },
      implementation: {
        kind: 'agent',
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
      },
    })
    expect(compatible.status).toBe('valid')
    expect(
      await service.validateAgentCandidates({
        contractRef: { contractId: 'development.analyze-implement', version: 1 },
        agentRefs: [
          { id: codeWriter.id, revision: codeWriter.updatedAt },
          { id: codeWriter.id, revision: codeWriter.updatedAt },
        ],
      }),
    ).toEqual([
      {
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
        validationReceipt: compatible,
      },
    ])
    const mismatched = await service.validateExecutor({
      contractRef: { contractId: 'development.prepare-materials', version: 1 },
      implementation: {
        kind: 'agent',
        agentRef: { id: codeWriter.id, revision: codeWriter.updatedAt },
      },
    })
    expect(mismatched.status).toBe('invalid')
    expect(mismatched.checks).toContainEqual(
      expect.objectContaining({ code: 'agent-contract-declared', ok: false }),
    )
  })

  test('Agent saves keep the contract-owned result port atomic with declaration lifecycle', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const created = await createAgent(db, {
      name: 'contract-owned-port',
      description: '',
      outputs: [],
      outputKinds: { 'agent-result': 'markdown' },
      branchPorts: ['agent-result'],
      inputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {
        executionContracts: [{ contractId: 'development.analyze-implement', version: 1 }],
      },
      bodyMd: '',
    })
    expect(created.outputs).toEqual(['agent-result'])
    expect(created.outputKinds).toEqual({})
    expect(created.branchPorts).toBeUndefined()

    const protectedPort = await updateAgent(db, created.id, {
      outputs: [],
      outputKinds: { 'agent-result': 'signal' },
      branchPorts: ['agent-result'],
    })
    expect(protectedPort.outputs).toEqual(['agent-result'])
    expect(protectedPort.outputKinds).toEqual({})
    expect(protectedPort.branchPorts).toBeUndefined()

    const removed = await updateAgent(db, created.id, {
      frontmatterExtra: {},
      outputs: ['ordinary', 'agent-result'],
      outputKinds: { ordinary: 'markdown', 'agent-result': 'signal' },
      branchPorts: ['agent-result'],
    })
    expect(removed.outputs).toEqual(['ordinary'])
    expect(removed.outputKinds).toEqual({ ordinary: 'markdown' })
    expect(removed.branchPorts).toBeUndefined()
  })

  test('Program validation executes the authored script with the same env input and stdout contract', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'execution-contract-program-'))
    roots.push(appHome)
    const source = `const input = JSON.parse(process.env.AW_PORT_CONTRACT_INPUT ?? '')
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  roundRef: input.roundRef,
  executionNonce: input.executionNonce,
  status: 'blocked',
  summary: 'fixture ' + input.inputSchemaId,
  contextPatches: [],
  effectSuggestions: [],
  artifactRefs: [],
}))`
    const artifact = await createProgramArtifactStore(appHome).put({
      runtimeKind: 'node',
      source,
      parameterValues: null,
    })
    const checks = await createExecutionContractProgramFixtureAdapter({
      appHome,
      scriptInterpreterOverrides: { node: process.execPath },
    }).validate({
      guide: guide('development.prepare-materials'),
      implementation: {
        kind: 'program',
        runtimeKind: 'node',
        ...artifact,
        runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
      },
    })
    expect(checks).toEqual([
      {
        code: 'program-fixture-exact-output',
        ok: true,
        detail: 'development.work-request.v1 -> development.requirement-context.v1',
      },
    ])
    expect(executionContractRefKey(guide('development.prepare-materials').contractRef)).toBe(
      'development.prepare-materials@1',
    )
  })

  test('the shared Script host keeps the platform contract input port explicit', () => {
    const snapshot = synthesizeDigitalEmployeeScriptHostSnapshot({
      inputPort: 'contract-input',
      language: 'node',
      script: 'process.stdout.write("{}")',
      dependencies: [],
      env: {},
      readonly: false,
    })
    expect(snapshot.inputs).toEqual([
      expect.objectContaining({ key: 'contract-input', required: true }),
    ])
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({ kind: 'input', inputKey: 'contract-input' }),
    )
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ portName: 'contract-input' }),
        target: expect.objectContaining({ portName: 'contract-input' }),
      }),
    )
  })
})
