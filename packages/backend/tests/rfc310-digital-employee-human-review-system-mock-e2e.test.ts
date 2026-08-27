// RFC-310 design §22.5 requires this branch as independent executable evidence:
// implementation must never start before review approval, iterate reruns only
// the planning Agent, and the implementation Agent consumes the exact approved
// plan. The two Agents below run through TaskEngine as a real child process;
// only their model output is deterministic system-mock data.

import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import {
  composeDigitalEmployeeExecution,
  inspectDigitalEmployeeHumanReviewState,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  DIGITAL_EMPLOYEE_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { addReviewComment, submitReviewDecision } from '@/services/review'
import {
  abortAllActiveTasks,
  isTaskActive,
  listTaskItems,
  wakeHumanGateContinuation,
} from '@/services/task'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []
const taskIds: string[] = []

setDefaultTimeout(60_000)

afterEach(async () => {
  abortAllActiveTasks('rfc310-human-review-system-mock-cleanup')
  for (const taskId of taskIds.splice(0)) {
    for (let attempt = 0; attempt < 500 && isTaskActive(taskId); attempt += 1) {
      await Bun.sleep(10)
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeAgentProcessMock(root: string): {
  readonly command: string[]
  readonly planningCountPath: string
  readonly implementationPromptPath: string
} {
  const scriptPath = join(root, 'review-agent-system-mock.ts')
  const planningCountPath = join(root, 'planning-count')
  const implementationPromptPath = join(root, 'implementation-prompt.log')
  writeFileSync(planningCountPath, '0')
  writeFileSync(implementationPromptPath, '')
  writeFileSync(
    scriptPath,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const planningCountPath = ${JSON.stringify(planningCountPath)}
const implementationPromptPath = ${JSON.stringify(implementationPromptPath)}
const argv = Bun.argv.slice(2)

if (argv[0] === '--version') {
  console.log('rfc310-review-system-mock 1.0.0')
  process.exit(0)
}
if (argv[0] !== 'run') {
  console.error('unexpected command: ' + String(argv[0]))
  process.exit(2)
}

const prompt = argv.join('\\n')
const protocolNonce = /nonce="([^"]*)"/.exec(prompt)?.[1] ?? ''
const xml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

function emit(port: string, content: string) {
  const open = protocolNonce.length > 0
    ? '<workflow-output nonce="' + protocolNonce + '">'
    : '<workflow-output>'
  const text = open + '<port name="' + port + '">' + xml(content) + '</port></workflow-output>'
  console.log(JSON.stringify({ type: 'text', ts: Math.floor(Date.now() / 1000), text }))
}

const inputMarker = prompt.includes('INPUT_JSON\\n\\n') ? 'INPUT_JSON\\n\\n' : 'INPUT_JSON\\n'
const inputMarkerIndex = prompt.lastIndexOf(inputMarker)
const encodedToolInput =
  inputMarkerIndex < 0
    ? null
    : prompt.slice(inputMarkerIndex + inputMarker.length).trimStart().split('\\n', 1)[0]
const toolInput = encodedToolInput === null ? null : JSON.parse(encodedToolInput)
const documentPath = typeof toolInput?.outputFile === 'string' ? toolInput.outputFile : null
if (documentPath !== null) {
  const planningOrdinal = Number(readFileSync(planningCountPath, 'utf8').trim()) + 1
  writeFileSync(planningCountPath, String(planningOrdinal))
  const body = '# Implementation plan v' + planningOrdinal
    + '\\n\\nExact approved marker: REVIEWED-V' + planningOrdinal
    + '\\n\\n1. Change the requested implementation.\\n2. Run focused tests.\\n'
  const absoluteDocumentPath = resolve(process.cwd(), documentPath)
  mkdirSync(dirname(absoluteDocumentPath), { recursive: true })
  writeFileSync(absoluteDocumentPath, body)
  emit('analysis-plan', documentPath)
  process.exit(0)
}

appendFileSync(implementationPromptPath, '\\n--- implementation invocation ---\\n' + prompt)
const exampleMarker = 'OUTPUT_SCHEMA_EXAMPLE_JSON\\n'
const exampleStart = prompt.lastIndexOf(exampleMarker)
if (exampleStart < 0) {
  console.error('implementation prompt has no output example')
  process.exit(3)
}
const exampleTail = prompt.slice(exampleStart + exampleMarker.length)
const exampleEnd = exampleTail.indexOf('\\nNever wrap the JSON')
if (exampleEnd < 0) {
  console.error('implementation prompt has no output example terminator')
  process.exit(4)
}
const output = JSON.stringify(JSON.parse(exampleTail.slice(0, exampleEnd)))
emit('agent-result', output)
`,
  )
  return {
    command: [process.execPath, scriptPath],
    planningCountPath,
    implementationPromptPath,
  }
}

describe('RFC-310 human-reviewed digital employee TaskEngine system mock E2E', () => {
  test('review iterations gate implementation while the internal TaskEngine execution stays out of the public task catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc310-human-review-'))
    roots.push(root)
    const appHome = join(root, 'home')
    const previousAppHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = appHome
    const db = createInMemoryDb(MIGRATIONS)

    try {
      await seedTestDefaultOpencodeRuntime(db)
      await ensureDigitalEmployeeAgentTemplates(db)
      const templates = await listDigitalEmployeeAgentTemplates(db)
      const planningAgent = templates.find(
        (agent) => agent.frontmatterExtra.digitalEmployeeTemplate === 'implementation-planning',
      )
      const implementationAgent = templates.find(
        (agent) => agent.frontmatterExtra.digitalEmployeeTemplate === 'code-writing',
      )
      if (planningAgent === undefined || implementationAgent === undefined) {
        throw new Error('built-in planning/code-writing Agent templates are missing')
      }

      const requirementDirectory = '.agent-workflow/inputs/requirements/review-case'
      const assembledEnvelope = JSON.parse(
        developmentEmployeeRuntimeCodec.assembleReactionInputJson(
          JSON.stringify({
            schemaVersion: 1,
            caseRef: 'review-case',
            roundRef: 'review-round',
            executionNonce: '7'.repeat(64),
            workItemRef: 'analyze-implement',
            toolSlotRef: 'default',
            connectionRef: null,
            inputSchemaId: 'development.requirement-context.v1',
            outputSchemaId: 'development.change-proposal.v1',
            eventJson: JSON.stringify({ kind: 'work-item-continuation' }),
            contextsJson: JSON.stringify([
              {
                id: 'review-issue-context',
                typeId: 'development.issue-handling',
                schemaVersion: 1,
                revision: 1,
                stateJson: JSON.stringify({
                  status: 'active',
                  subjectRef: 'case:review-case',
                  repositoryRef: 'review-repository',
                  request: {
                    kind: 'body',
                    body: 'Implement only after the reviewed plan is approved.',
                    externalId: null,
                    uploads: [],
                    executionOptions: { 'review-implementation-plan': true },
                  },
                  materialArtifactRefs: [],
                  deliveryContent: null,
                }),
                artifactRefs: [],
              },
            ]),
            toolBindingsJson: JSON.stringify([
              {
                slotRef: 'plan',
                registrationRef: { id: 'review-planning-tool', revision: 1 },
                workContractRef: {
                  contractId: 'development.plan-implementation',
                  version: 2,
                },
                implementation: {
                  kind: 'agent',
                  agentRef: { id: planningAgent.id, revision: planningAgent.updatedAt },
                },
              },
            ]),
          }),
        ),
      ) as Record<string, unknown>
      assembledEnvelope.executionEnvironmentJson = JSON.stringify({ kind: 'scratch' })
      expect(assembledEnvelope.humanReview).toMatchObject({
        kind: 'implementation-plan',
        documentPath: `${requirementDirectory}/review/implementation-plan.md`,
        planningTool: {
          workContractRef: {
            contractId: 'development.plan-implementation',
            version: 2,
          },
          implementation: {
            kind: 'agent',
            agentRef: { id: planningAgent.id, revision: planningAgent.updatedAt },
          },
        },
      })

      const executionContracts = new ExecutionContractService({
        registrations: developmentExecutionContractRegistrations,
        resources: {
          async inspect() {
            return null
          },
        },
        programFixtures: {
          async validate() {
            return []
          },
        },
      })
      const processMock = makeAgentProcessMock(root)
      const startDeps = {
        db,
        schedulerDriver: createTaskExecutionTestTopology({ db, driver: 'real' }).schedulerDriver,
        appHome,
        binaryOverride: processMock.command,
        awaitScheduler: true,
        defaultPerNodeTimeoutMs: 20_000,
        defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
      }
      const execution = composeDigitalEmployeeExecution({
        db,
        appHome,
        startDeps,
        executionContracts,
      })
      const plan = {
        schemaVersion: 1,
        caseRef: { id: 'review-case', revision: 1 },
        roundRef: 'review-round',
        executionNonce: '7'.repeat(64),
        workItemRef: 'analyze-implement',
        toolSlotRef: 'default',
        connectionRef: null,
        implementationRef: { id: 'review-implementation-tool', revision: 1 },
        implementationKind: 'agent',
        implementationJson: JSON.stringify({
          kind: 'agent',
          agentRef: { id: implementationAgent.id, revision: implementationAgent.updatedAt },
        }),
        inputEnvelopeJson: JSON.stringify(assembledEnvelope),
        inputSchemaId: 'development.requirement-context.v1',
        outputSchemaId: 'development.change-proposal.v1',
        workContractRef: { contractId: 'development.analyze-implement', version: 1 },
        semanticValidatorId: 'development.analyze-implement.validator',
        allowedEffectKinds: [],
        roundBudgetMs: 30_000,
      }
      const receipt = await execution.launch(
        JSON.stringify(plan),
        JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null }),
      )
      const taskId = receipt.executionRef
      taskIds.push(taskId)

      expect(inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('waiting')
      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_review',
        catalogVisibility: 'internal',
      })
      expect(
        (await listTaskItems(db, { catalogVisibility: 'public' })).map((item) => item.id),
      ).not.toContain(taskId)
      expect(readFileSync(processMock.planningCountPath, 'utf8')).toBe('1')
      expect(readFileSync(processMock.implementationPromptPath, 'utf8')).toBe('')
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_AGENT_NODE_ID)),
          )
          .all(),
      ).toHaveLength(0)

      const reviewRun = db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID),
          ),
        )
        .get()
      if (reviewRun === undefined) throw new Error('review node did not enter durable waiting')
      await addReviewComment({
        db,
        appHome,
        nodeRunId: reviewRun.id,
        anchor: {
          sectionPath: '# Implementation plan v1',
          paragraphIdx: 0,
          offsetStart: 0,
          offsetEnd: 19,
          selectedText: 'Implementation plan',
          contextBefore: '',
          contextAfter: '',
          occurrenceIndex: 1,
        },
        commentText: 'Add the exact focused verification step.',
      })
      const rejected = await submitReviewDecision({
        db,
        appHome,
        nodeRunId: reviewRun.id,
        decision: 'rejected',
        rejectReason: 'The plan must include the exact focused verification step.',
        expectedReviewIteration: 0,
      })
      await wakeHumanGateContinuation(rejected.taskId, rejected.continuationRef, startDeps)

      expect(inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('waiting')
      expect(readFileSync(processMock.planningCountPath, 'utf8')).toBe('2')
      expect(readFileSync(processMock.implementationPromptPath, 'utf8')).toBe('')
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_AGENT_NODE_ID)),
          )
          .all(),
      ).toHaveLength(0)
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.taskId, taskId),
              eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID),
            ),
          )
          .all(),
      ).toHaveLength(2)

      const waitingReview = db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRun.id)).get()
      expect(waitingReview).toMatchObject({ status: 'awaiting_review', reviewIteration: 1 })
      await addReviewComment({
        db,
        appHome,
        nodeRunId: reviewRun.id,
        anchor: {
          sectionPath: '# Implementation plan v2',
          paragraphIdx: 0,
          offsetStart: 0,
          offsetEnd: 19,
          selectedText: 'Implementation plan',
          contextBefore: '',
          contextAfter: '',
          occurrenceIndex: 1,
        },
        commentText: 'Keep the focused check and make the sequence explicit.',
      })
      const iterated = await submitReviewDecision({
        db,
        appHome,
        nodeRunId: reviewRun.id,
        decision: 'iterated',
        expectedReviewIteration: 1,
      })
      await wakeHumanGateContinuation(iterated.taskId, iterated.continuationRef, startDeps)

      expect(inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('waiting')
      expect(readFileSync(processMock.planningCountPath, 'utf8')).toBe('3')
      expect(readFileSync(processMock.implementationPromptPath, 'utf8')).toBe('')
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_AGENT_NODE_ID)),
          )
          .all(),
      ).toHaveLength(0)
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.taskId, taskId),
              eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID),
            ),
          )
          .all(),
      ).toHaveLength(3)
      expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRun.id)).get()).toMatchObject({
        status: 'awaiting_review',
        reviewIteration: 2,
      })
      const approved = await submitReviewDecision({
        db,
        appHome,
        nodeRunId: reviewRun.id,
        decision: 'approved',
        expectedReviewIteration: 2,
      })
      await wakeHumanGateContinuation(approved.taskId, approved.continuationRef, startDeps)

      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'done',
        catalogVisibility: 'internal',
      })
      expect(
        (await listTaskItems(db, { catalogVisibility: 'public' })).map((item) => item.id),
      ).not.toContain(taskId)
      expect(inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('approved')
      expect(
        db
          .select()
          .from(nodeRuns)
          .where(
            and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_AGENT_NODE_ID)),
          )
          .all(),
      ).toEqual([expect.objectContaining({ status: 'done' })])
      const implementationPrompt = readFileSync(processMock.implementationPromptPath, 'utf8')
      expect(implementationPrompt).toContain('Exact approved marker: REVIEWED-V3')
      expect(implementationPrompt).not.toContain('Exact approved marker: REVIEWED-V2')
      expect(implementationPrompt).not.toContain('Exact approved marker: REVIEWED-V1')

      const versions = db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, reviewRun.id))
        .all()
      expect(versions.map((version) => version.decision)).toEqual([
        'rejected',
        'iterated',
        'approved',
      ])
      const approvedOutput = db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, reviewRun.id),
            eq(nodeRunOutputs.portName, 'approved_doc'),
          ),
        )
        .get()
      expect(approvedOutput).toMatchObject({
        content: `${requirementDirectory}/review/implementation-plan.md`,
        kind: 'path<md>',
      })
      expect(
        existsSync(
          join(
            db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.worktreePath!,
            `${requirementDirectory}/review/implementation-plan.md`,
          ),
        ),
      ).toBe(true)

      const settled = await execution.inspect(taskId)
      expect(settled).toMatchObject({ kind: 'completed', executionRef: taskId })
      if (settled.kind !== 'completed') throw new Error('reviewed execution did not complete')
      expect(JSON.parse(settled.outputJson)).toMatchObject({
        schemaVersion: 1,
        roundRef: 'review-round',
        executionNonce: '7'.repeat(64),
        status: 'ok',
      })
    } finally {
      abortAllActiveTasks('rfc310-human-review-system-mock-finally')
      db.$client.close()
      if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousAppHome
    }
  })
})
