// The graph-to-MR handoff must survive the real codec, catalog, admission and execution seams.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptNodeSchema } from '@agent-workflow/shared'
import { actorOfDirectAuthority, admitDaemonIdentity } from '@/auth/session'
import {
  GraphEmployeeContextSchema,
  graphEmployeeRuntimeCodec,
  type GraphEmployeeContext,
} from '@/modules/development-automation/application/graph-development/employeeCodec'
import {
  GRAPH_CONTEXT_TYPE,
  graphEmployeeTypePackage,
} from '@/modules/development-automation/application/graph-development/employeeType'
import { graphExecutionContractRegistrations } from '@/modules/development-automation/application/graph-development/toolContracts'
import {
  developmentEmployeeTypePackage,
  issueHandlingContextSchema,
  changeCandidateContextSchema,
  mergeRequestLifecycleDescriptor,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeGraphDeliveryLifecycleRuntimeCodec,
  composeGraphDeliveryLifecycleTypePackage,
  GRAPH_DELIVERY_EMPLOYEE_TYPE,
} from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import { employeeTypePackageDescriptorSchema } from '@/modules/digital-employee/domain/model'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { createEventStore } from '@/modules/event-center/infrastructure/eventStore'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { EXECUTION_CONTRACT_SCRIPT_INPUT_PORT } from '@/modules/execution-contract/public/types'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeDigitalEmployeeExecutionCore } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import type { RootTaskLaunchRequest } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { describeEachProvider } from './helpers/eachProvider'
import { composeEventCenter } from './helpers/eventCenter'

const graph = composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec)
const graphPackage = composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage)
const graphDescriptor = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(graphPackage.descriptorJson),
)
const headSha = 'a'.repeat(40)
const treeOid = 'b'.repeat(40)
const candidateRef = 'c'.repeat(64)
const executionNonce = 'd'.repeat(64)
const deliveryArtifacts = ['graph-evidence:verified-tree', 'graph-basis:approved']
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function initialContext(revision: 1 | 2): GraphEmployeeContext {
  const initial = JSON.parse(
    graph.buildInitialCaseJson(
      JSON.stringify({
        schemaVersion: 1,
        caseRef: 'graph-case',
        employeeRef: { id: 'graph-employee', revision: 1 },
        employeeTypeRef: { typeId: 'graph-development', revision },
        workScopeJson: JSON.stringify({ kind: 'task' }),
        receivedAt: 1,
        intake: {
          target: { repositoryId: 'repo' },
          kind: 'body',
          body: 'Reject duplicate bookings.',
          typeOptions: { 'working-branch': 'main', 'publication-branch': 'reviewed-booking' },
          uploads: [],
        },
      }),
    ),
  ) as { primaryContextJson: string }
  return GraphEmployeeContextSchema.parse({
    ...JSON.parse(initial.primaryContextJson),
    consumedRevision: 3,
    basisId: 'approved-basis',
    basisDigest: 'e'.repeat(64),
    reviewReceiptId: 'approved-review',
    reviewDecision: 'approved',
    candidateRef,
    candidateTreeOid: treeOid,
    evidenceIds: ['verified-tree'],
    result: 'verified',
  })
}

function context(typeId: string, state: unknown, revision = 1) {
  return {
    id: `${typeId}-context`,
    typeId,
    schemaVersion: 1,
    revision,
    lifecycleState: 'active',
    stateJson: JSON.stringify(state),
    artifactRefs: ['original-requirement'],
  }
}

const issueState = issueHandlingContextSchema.parse({
  status: 'active',
  subjectRef: 'case:graph-case',
  repositoryRef: 'repo',
  request: {
    kind: 'body',
    body: 'Reject duplicate bookings.',
    externalId: null,
    uploads: [],
    workingBranch: 'reviewed-booking',
  },
  materialArtifactRefs: deliveryArtifacts,
  deliveryContent: {
    commitMessage: 'fix: reject duplicate bookings',
    mergeRequestTitle: 'Apply the approved booking rule',
    mergeRequestDescription: 'Carries the graph design and verified candidate into MR care.',
  },
})
const candidateState = changeCandidateContextSchema.parse({
  status: 'prepared',
  candidateRef,
  baselineSha: headSha,
  treeOid,
  summarySource: 'Approved booking design, verified on the candidate tree.',
  changedPaths: ['src/booking.ts', 'src/booking.test.ts'],
  commitSha: headSha,
})
const handoff = {
  issueStateJson: JSON.stringify(issueState),
  candidateStateJson: JSON.stringify(candidateState),
}

interface ContextPatch {
  contextId: string | null
  contextTypeId: string
  expectedRevision: number | null
  lifecycleState: string
  stateJson: string
  artifactRefs: string[]
}
interface NormalizedOutput {
  status: string
  contextPatches: ContextPatch[]
  artifactRefs: string[]
}

function delivery(
  revision: 1 | 2,
  includeHandoff: boolean,
  existing: ReturnType<typeof context>[] = [],
) {
  const inputEnvelopeJson = JSON.stringify({
    roundRef: 'deliver-round',
    executionNonce,
    contextsJson: JSON.stringify([
      context(GRAPH_CONTEXT_TYPE, initialContext(revision), 4),
      ...existing,
    ]),
  })
  const outputJson = graph.validateReactionOutputJson(
    JSON.stringify({
      employeeTypeRef: { typeId: 'graph-development', revision },
      workItemRef: 'deliver-result',
      inputEnvelopeJson,
      outputJson: JSON.stringify({
        schemaVersion: 1,
        roundRef: 'deliver-round',
        executionNonce,
        directResult: {
          summary: 'The approved candidate is ready for delivery.',
          result: {
            artifactRefs: deliveryArtifacts,
            commitSha: headSha,
            publication: null,
            ...(includeHandoff ? { mergeRequestDelivery: handoff } : {}),
          },
        },
      }),
    }),
  )
  return { inputEnvelopeJson, outputJson, output: JSON.parse(outputJson) as NormalizedOutput }
}

function settle(revision: 1 | 2, result: ReturnType<typeof delivery>) {
  const descriptor =
    revision === 2
      ? graphDescriptor
      : employeeTypePackageDescriptorSchema.parse(
          JSON.parse(graphEmployeeTypePackage.descriptorJson),
        )
  return JSON.parse(
    graph.resolveReactionSettlementJson(
      JSON.stringify({
        employeeTypeRef: { typeId: 'graph-development', revision },
        workItemRef: 'deliver-result',
        inputEnvelopeJson: result.inputEnvelopeJson,
        outputJson: result.outputJson,
        allowedNextWorkItemRefs: descriptor.authoringManifest.workItems.find(
          (item) => item.workItemRef === 'deliver-result',
        )!.nextWorkItemRefs,
      }),
    ),
  ) as {
    caseState: string
    terminalKind: string | null
    nextWorkItemRef: string | null
    contextPatches: ContextPatch[]
  }
}

describe('RFC-396 composed graph delivery codec', () => {
  test('graph@2 keeps its verified graph context, adds valid MR contexts and continues to publish-mr', () => {
    expect(initialContext(2).request.deliveryMode).toBe('merge-request')
    const result = delivery(2, true)
    expect(result.output.status).toBe('ok')
    expect(result.output.contextPatches.map((patch) => patch.contextTypeId)).toEqual([
      GRAPH_CONTEXT_TYPE,
      'development.issue-handling',
      'development.change-candidate',
    ])
    for (const patch of result.output.contextPatches) {
      expect(() => graph.validateContextJson(patch.contextTypeId, patch.stateJson)).not.toThrow()
      expect(patch.lifecycleState).toBe('active')
    }
    expect(result.output.contextPatches[0]).toMatchObject({
      contextId: `${GRAPH_CONTEXT_TYPE}-context`,
      expectedRevision: 4,
    })
    expect(JSON.parse(result.output.contextPatches[0]!.stateJson)).toMatchObject({
      caseId: 'graph-case',
      designId: 'design:graph-case',
      result: 'monitoring',
      basisId: 'approved-basis',
      reviewReceiptId: 'approved-review',
      candidateRef,
      candidateTreeOid: treeOid,
    })
    expect(result.output.contextPatches.slice(1)).toEqual([
      expect.objectContaining({
        contextId: null,
        expectedRevision: null,
        stateJson: handoff.issueStateJson,
        artifactRefs: deliveryArtifacts,
      }),
      expect.objectContaining({
        contextId: null,
        expectedRevision: null,
        stateJson: handoff.candidateStateJson,
        artifactRefs: deliveryArtifacts,
      }),
    ])
    expect(settle(2, result)).toMatchObject({
      caseState: 'active',
      terminalKind: null,
      nextWorkItemRef: 'publish-mr',
      contextPatches: result.output.contextPatches,
    })
  })

  test('a resumed MR handoff addresses the existing context revisions instead of creating duplicates', () => {
    const result = delivery(2, true, [
      context('development.issue-handling', issueState, 2),
      context('development.change-candidate', candidateState, 3),
    ])
    expect(result.output.contextPatches.slice(1)).toEqual([
      expect.objectContaining({
        contextId: 'development.issue-handling-context',
        expectedRevision: 2,
      }),
      expect.objectContaining({
        contextId: 'development.change-candidate-context',
        expectedRevision: 3,
      }),
    ])
    expect(settle(2, result).nextWorkItemRef).toBe('publish-mr')
  })

  test('frozen graph@1 cases still deliver an internal candidate and become terminal', () => {
    expect(initialContext(1).request.deliveryMode).toBeUndefined()
    const result = delivery(1, false)
    expect(result.output.contextPatches).toHaveLength(1)
    expect(result.output.contextPatches[0]!.lifecycleState).toBe('terminal')
    expect(JSON.parse(result.output.contextPatches[0]!.stateJson).result).toBe('delivered')
    expect(settle(1, result)).toMatchObject({
      caseState: 'terminal',
      terminalKind: 'graph-development.delivered',
      nextWorkItemRef: null,
    })
  })

  test('MR-mode delivery cannot silently finish without the development handoff', () => {
    expect(() => delivery(2, false)).toThrow('graph-mr-delivery-handoff-missing')
  })
})

describeEachProvider('RFC-396 MR catalog and runtime wiring', (harness) => {
  test('development, graph@1 and graph@2 register shared event identities once and survive reverse-order restart', async () => {
    const descriptors = [
      developmentEmployeeTypePackage.descriptorJson,
      graphEmployeeTypePackage.descriptorJson,
      graphPackage.descriptorJson,
    ]
    const options = { db: harness.db, automation: { kind: 'observation-only' as const } }
    await composeEventCenter({ ...options, typePackageDescriptorJsons: descriptors })
    const store = createEventStore(harness.db)
    const sources = await store.listSources()
    const events = await store.listEventTypes()
    expect(
      new Set(events.map((event) => `${event.eventTypeRef.id}@${event.eventTypeRef.revision}`))
        .size,
    ).toBe(events.length)
    expect(
      new Set(sources.map((source) => `${source.sourceRef.id}@${source.sourceRef.revision}`)).size,
    ).toBe(sources.length)
    for (const event of mergeRequestLifecycleDescriptor.eventTypes) {
      expect(
        events.find(
          (entry) =>
            entry.eventTypeRef.id === event.eventTypeId &&
            entry.eventTypeRef.revision === event.version,
        ),
      ).toMatchObject({
        ownerTypeId: 'development',
        sourceRef: event.sourceRef,
      })
    }
    for (const source of mergeRequestLifecycleDescriptor.eventSources) {
      expect(
        sources.find(
          (entry) =>
            entry.sourceRef.id === source.sourceId && entry.sourceRef.revision === source.version,
        ),
      ).toMatchObject({ ownerTypeId: source.ownerTypeId ?? 'development' })
    }
    for (const event of graphDescriptor.eventTypes.filter((entry) =>
      entry.eventTypeId.startsWith('graph-development.'),
    )) {
      expect(
        events.find(
          (entry) =>
            entry.eventTypeRef.id === event.eventTypeId &&
            entry.eventTypeRef.revision === event.version,
        ),
      ).toMatchObject({ ownerTypeId: 'graph-development' })
    }
    await composeEventCenter({ ...options, typePackageDescriptorJsons: [...descriptors].reverse() })
    expect(await store.listSources()).toEqual(sources)
    expect(await store.listEventTypes()).toEqual(events)
  })

  test('production launchWork passes the exact graph@2 type into the persisted primary context', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc396-mr-admission-'))
    homes.push(home)
    const f = employeeAutomationFixture(harness, home)
    await ensureDigitalEmployeeAgentTemplates(f.tasks.resourceCatalog.digitalEmployeeAgentTemplates)
    await f.employee.platformTools.load()
    await f.employee.module.maintenance.ready()
    await f.employee.initializeGraph()
    await f.employeeInput.integration.eventCenter.initialize()
    const jobs = await f.employee.module.queries.listJobTemplates(GRAPH_DELIVERY_EMPLOYEE_TYPE)
    const job = jobs.find((item) => item.id === 'platform:graph-development:job:mr-v1')!
    expect(job.publishedRevision).not.toBeNull()
    const employee = await f.employee.module.commands.createEmployee({
      typeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
      actorUserId: null,
      body: {
        name: 'Graph MR admission fixture',
        jobTemplateRef: { id: job.id, revision: job.publishedRevision },
        workScope: { kind: 'task' },
        toolOverrides: [],
      },
    })
    const runtime = f.employee.module.runtime!
    const launched = await runtime.commands.launchWork({
      employeeId: employee.id,
      actorUserId: null,
      intake: {
        name: 'Booking MR',
        kind: 'body',
        body: 'Reject duplicate bookings.',
        uploads: [],
        target: { repositoryId: 'repo' },
        executionOptions: {},
        externalId: null,
        idempotencyKey: 'graph-mr-admission',
        advanced: {
          typeOptions: { 'working-branch': 'main', 'publication-branch': 'reviewed-booking' },
        },
      },
    })
    const contexts = await createRuntimePersistence(harness.db).listContexts(launched.caseRef.id)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.typeId).toBe(GRAPH_CONTEXT_TYPE)
    expect(GraphEmployeeContextSchema.parse(JSON.parse(contexts[0]!.stateJson))).toMatchObject({
      caseId: launched.caseRef.id,
      designId: `design:${launched.caseRef.id}`,
      repositoryId: 'repo',
      result: 'designing',
      request: {
        deliveryMode: 'merge-request',
        targetBranch: 'main',
        publicationBranch: 'reviewed-booking',
      },
    })
    const projection = JSON.parse(
      (await runtime.queries.getCase(launched.caseRef.id)).projectionJson,
    )
    expect(projection.case).toMatchObject({
      typeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
      currentWorkItemRef: 'understand-request',
    })
  }, 30_000)

  for (const implementationKind of ['agent', 'program'] as const) {
    test(`${implementationKind} execution receives material directions without rewriting the frozen JSON envelope`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'rfc396-mr-materials-'))
      homes.push(home)
      const identity = createIdentityAccessRuntime({ db: harness.db })
      const admitted = await admitDaemonIdentity(identity)
      if (!admitted) throw new Error('fixture daemon identity unavailable')
      const actor = actorOfDirectAuthority(admitted)
      const executionContracts = composeExecutionContract({
        registrations: graphExecutionContractRegistrations,
        resources: {
          async inspect() {
            throw new Error('launch does not revalidate frozen executor selection')
          },
        },
        programFixtures: {
          async run() {
            throw new Error('launch does not rerun publication fixtures')
          },
        },
      })
      const contract = { contractId: 'graph-development.implement-change', version: 1 }
      const guide = executionContracts.get(contract)
      const work = initialContext(2)
      const inputEnvelopeJson = JSON.stringify({
        schemaVersion: 1,
        roundRef: 'material-round',
        executionNonce,
        executionEnvironmentJson: JSON.stringify({ kind: 'scratch' }),
        contractInput: { work, materials: { frozen: 'kept-in-round' } },
      })
      const projectedMaterials = { approvedBasisPath: '.agent-workflow/graph/approved-basis.json' }
      const materialInstructions =
        'Read .agent-workflow/graph/approved-basis.json before editing. Preserve the approved booking rule.'
      const captures: RootTaskLaunchRequest[] = []
      const prepared: string[] = []
      const launchBoundary = new Error('captured task launch boundary')
      const core = composeDigitalEmployeeExecutionCore({
        appHome: home,
        resolveActor: async () => actor,
        resourceAuthorityFor: () => ({
          actor,
          authority: identity.directAuthority.authorityForLegacyProjection(actor),
          resources: {
            async loadAuthorized() {
              throw new Error('captured kernel does not read resources')
            },
            async freezeCallClosure() {
              throw new Error('captured kernel does not freeze resources')
            },
          },
        }),
        launch: {
          async launch(input) {
            captures.push(input)
            throw launchBoundary
          },
        },
        tasks: {
          async get() {
            throw new Error('launch does not inspect tasks')
          },
          async cancel() {
            throw new Error('launch does not cancel tasks')
          },
        },
        readModels: {
          executionOutcome: {
            async find() {
              throw new Error('launch does not inspect outcomes')
            },
          },
        },
        resourceUsage: {
          async read() {
            throw new Error('launch does not inspect usage')
          },
        },
        agents: {
          async get(id) {
            return {
              id,
              name: 'graph material fixture',
              updatedAt: 1,
              outputs: [DIGITAL_EMPLOYEE_RESULT_PORT],
            }
          },
        },
        workflows: {
          async get() {
            throw new Error('fixture does not select a workflow')
          },
        },
        executionMetadata: {
          async load() {
            throw new Error('launch does not inspect metadata')
          },
        },
        humanReview: {
          async inspect() {
            throw new Error('launch does not inspect human review')
          },
        },
        programs: {
          async read() {
            return { kind: 'ok', source: 'console.log("fixture")', parameterValuesJson: '{}' }
          },
        },
        workspace: {
          async prepare(input) {
            prepared.push(input.planJson)
            return {
              kind: 'repository',
              workspacePath: join(home, 'scene'),
              baselineSha: headSha,
              platformInputPaths: [projectedMaterials.approvedBasisPath],
              materialInstructions,
              contractProjectionJson: JSON.stringify({ materials: projectedMaterials }),
            }
          },
          async validate() {
            throw new Error('launch does not validate a completed workspace')
          },
        },
        executionContracts,
      })
      const plan = {
        schemaVersion: 1,
        caseRef: { id: 'graph-case', revision: 1 },
        roundRef: 'material-round',
        executionNonce,
        toolSlotRef: 'default',
        connectionRef: null,
        implementationRef: { id: `fixture-${implementationKind}`, revision: 1 },
        implementationKind,
        implementationJson: JSON.stringify(
          implementationKind === 'agent'
            ? { kind: 'agent', agentRef: { id: 'graph-agent', revision: 1 } }
            : {
                kind: 'program',
                runtimeKind: 'node',
                executableArtifactRef: 'program:fixture',
                executableDigest: 'f'.repeat(64),
                parameterValuesRef: null,
                runtimeProfileRef: { id: 'fixture-runtime', revision: 1 },
              },
        ),
        inputEnvelopeJson,
        inputSchemaId: guide.inputSchemaId,
        outputSchemaId: guide.outputSchemaId,
        workContractRef: contract,
        semanticValidatorId: 'graph-development.implement-change.validator',
        allowedEffectKinds: [],
        roundBudgetMs: 30_000,
        maxTotalTokens: 10_000,
      }
      const frozenPlan = JSON.stringify(plan)
      await expect(
        core.launch({
          plan,
          attempt: { ordinal: 0, mode: 'initial', previousError: null },
          taskId: `material-${implementationKind}`,
        }),
      ).rejects.toBe(launchBoundary)
      expect(prepared).toEqual([frozenPlan])
      expect(JSON.stringify(plan)).toBe(frozenPlan)
      expect(plan.inputEnvelopeJson).toBe(inputEnvelopeJson)
      expect(captures).toHaveLength(1)
      const captured = captures[0]!
      expect(captured.internal?.preallocatedTaskId).toBe(`material-${implementationKind}`)
      expect(captured.internal?.platformInputPaths).toEqual([projectedMaterials.approvedBasisPath])
      if (implementationKind === 'agent') {
        const prompt = captured.task.inputs[DIGITAL_EMPLOYEE_PROMPT_KEY]
        expect(typeof prompt).toBe('string')
        if (typeof prompt !== 'string') throw new Error('missing agent prompt')
        expect(prompt.startsWith(`${materialInstructions}\n\n`)).toBe(true)
        const marker = '\n\nINPUT_JSON\n'
        const markerIndex = prompt.lastIndexOf(marker)
        expect(markerIndex).toBeGreaterThan(materialInstructions.length)
        const tail = prompt.slice(markerIndex + marker.length)
        expect(tail).toBe(JSON.stringify({ work, materials: projectedMaterials }))
        expect(JSON.parse(tail)).toEqual({ work, materials: projectedMaterials })
        expect(tail).not.toContain(materialInstructions)
      } else {
        expect(
          JSON.parse(String(captured.task.inputs[EXECUTION_CONTRACT_SCRIPT_INPUT_PORT])),
        ).toEqual({ work, materials: projectedMaterials })
        const script = captured.subject.workflowSnapshot.nodes.find(
          (node) => node.kind === 'script',
        )
        expect(script?.kind).toBe('script')
        if (script?.kind !== 'script') throw new Error('missing program node')
        const environment = ScriptNodeSchema.parse(script).env
        expect(environment?.DIGITAL_EMPLOYEE_MATERIAL_INSTRUCTIONS).toBe(materialInstructions)
        expect(environment?.DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON).toBe('{}')
      }
    })
  }
})
