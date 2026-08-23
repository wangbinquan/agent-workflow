import { and, desc, eq } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'

import { isTerminalTaskStatus, type StartTask } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '@/db/schema'
import type { DigitalEmployeeExecutionParticipant } from '../public/participants'
import {
  EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
  buildExecutionContractAgentPrompt,
  type ExecutionContractParticipant,
  type ExecutionContractRuntimeView,
} from '@/modules/execution-contract/public/types'
import { getAgentById } from '@/services/agent'
import { getExecutionOutcome } from '@/services/execution/executor'
import { cancelTask, startTask, type StartTaskDeps } from '@/services/task'
import { sha256Hex } from '@/util/hash'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeReviewedDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
} from '../domain/digitalEmployeeHost'
import { ensureDigitalEmployeeHostWorkflow } from './agentActionExecution'
import type { DigitalEmployeeWorkspacePort } from './required-ports'

const exactRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

const agentImplementationSchema = z
  .object({ kind: z.literal('agent'), agentRef: exactRefSchema })
  .strict()
const workflowImplementationSchema = z
  .object({ kind: z.literal('workflow'), workflowRef: exactRefSchema })
  .strict()
const programImplementationSchema = z
  .object({
    kind: z.literal('program'),
    runtimeKind: z.enum(['bash', 'node', 'python']),
    executableArtifactRef: z.string().min(1),
    executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
    parameterValuesRef: z.string().min(1).nullable(),
    runtimeProfileRef: exactRefSchema,
  })
  .strict()
const implementationSchema = z.discriminatedUnion('kind', [
  agentImplementationSchema,
  workflowImplementationSchema,
  programImplementationSchema,
])

const programParametersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseRef: exactRefSchema,
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    toolSlotRef: z.string().min(1),
    connectionRef: exactRefSchema.nullable(),
    implementationRef: exactRefSchema.nullable(),
    implementationKind: z.enum(['agent', 'workflow', 'program']),
    implementationJson: z.string().min(2),
    inputEnvelopeJson: z.string().min(2),
    inputSchemaId: z.string().min(1),
    outputSchemaId: z.string().min(1),
    workContractRef: z
      .object({ contractId: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    semanticValidatorId: z.string().min(1),
    roundBudgetMs: z.number().int().positive(),
  })
  .passthrough()

const environmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scratch') }).strict(),
  z.object({ kind: z.literal('cached-repository'), cachedRepoId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('repository-group'), repoGroupId: z.string().min(1) }).strict(),
])

const humanReviewSchema = z
  .object({
    kind: z.literal('implementation-plan'),
    artifactPort: z.string().min(1),
    documentPath: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    planningTool: z
      .object({
        slotRef: z.literal('plan'),
        registrationRef: exactRefSchema,
        workContractRef: z
          .object({ contractId: z.literal('development.analyze-plan'), version: z.literal(1) })
          .strict(),
        implementation: agentImplementationSchema,
      })
      .strict(),
  })
  .strict()

const inputEnvelopeSchema = z
  .object({
    executionEnvironmentJson: z.string().min(2),
    humanReview: humanReviewSchema.nullable().default(null),
  })
  .passthrough()

const attemptSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
    previousError: z.string().max(4_000).nullable(),
  })
  .strict()

function resultFailure(executionRef: string, errorCode: string, errorDetail: string) {
  return {
    kind: 'failed' as const,
    executionRef,
    errorCode,
    errorDetail: errorDetail.slice(0, 2_000),
  }
}

function containedArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

export function buildDigitalEmployeeFixedPrompt(
  plan: Pick<
    z.infer<typeof planSchema>,
    'roundRef' | 'executionNonce' | 'toolSlotRef' | 'semanticValidatorId' | 'inputEnvelopeJson'
  >,
  attempt: Pick<z.infer<typeof attemptSchema>, 'previousError'>,
  guide: ExecutionContractRuntimeView,
): string {
  return buildExecutionContractAgentPrompt({
    guide,
    roundRef: plan.roundRef,
    executionNonce: plan.executionNonce,
    toolSlotRef: plan.toolSlotRef,
    semanticValidatorId: plan.semanticValidatorId,
    inputEnvelopeJson: plan.inputEnvelopeJson,
    policyLines: [
      'Do not run git, commit, push, merge, approve, call a code host, or choose the next action.',
      'Only modify business files allowed by the supplied workspace contract.',
    ],
    previousError: attempt.previousError,
  })
}

export function buildDigitalEmployeePlanPrompt(
  plan: Pick<z.infer<typeof planSchema>, 'roundRef' | 'executionNonce' | 'inputEnvelopeJson'>,
  attempt: Pick<z.infer<typeof attemptSchema>, 'previousError'>,
  documentPath: string,
): string {
  return [
    'You are preparing a read-only implementation plan for human review.',
    'Read every requirement body, uploaded repositoryPath, external material directory, and relevant repository file listed by the frozen input envelope.',
    `Write the complete Markdown plan only to this exact platform path: ${documentPath}`,
    'Do not modify any other file or run git, commit, push, merge, approve, or call a code host.',
    `Publish exactly ${documentPath} through the analysis-plan output port; no other output path is accepted.`,
    'The plan must cover requirement understanding, affected code, implementation steps, tests, risks, assumptions, and unresolved questions.',
    `ROUND_REF: ${plan.roundRef}`,
    `EXECUTION_NONCE: ${plan.executionNonce}`,
    `EXPECTED_ANALYSIS_PLAN_PATH_JSON\n${JSON.stringify(documentPath)}`,
    attempt.previousError === null ? '' : `PREVIOUS_ERROR:\n${attempt.previousError}`,
    'INPUT_ENVELOPE_JSON',
    plan.inputEnvelopeJson,
  ]
    .filter((line) => line.length > 0)
    .join('\n\n')
}

export function inspectDigitalEmployeeHumanReviewState(
  db: DbClient,
  executionRef: string,
): 'planning' | 'waiting' | 'approved' | 'failed' | null {
  const task = db
    .select({ inputs: tasks.inputs })
    .from(tasks)
    .where(eq(tasks.id, executionRef))
    .get()
  if (task === undefined) return null
  let parsedInputs: z.SafeParseReturnType<unknown, Record<string, unknown>>
  try {
    parsedInputs = z.record(z.string(), z.unknown()).safeParse(JSON.parse(task.inputs) as unknown)
  } catch {
    return null
  }
  if (
    !parsedInputs.success ||
    typeof parsedInputs.data[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY] !== 'string'
  ) {
    return null
  }
  const reviewRun = db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, executionRef),
        eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .get()
  if (reviewRun?.status === 'awaiting_review') return 'waiting'
  if (reviewRun?.status === 'done') return 'approved'
  if (
    reviewRun !== undefined &&
    ['failed', 'canceled', 'interrupted', 'skipped', 'exhausted'].includes(reviewRun.status)
  ) {
    return 'failed'
  }
  return 'planning'
}

export function composeDigitalEmployeeExecution(deps: {
  readonly db: DbClient
  readonly appHome: string
  readonly startDeps: StartTaskDeps
  readonly workspace?: DigitalEmployeeWorkspacePort
  readonly executionContracts: ExecutionContractParticipant
}): DigitalEmployeeExecutionParticipant {
  return {
    async launch(planJson, attemptJson) {
      const plan = planSchema.parse(JSON.parse(planJson) as unknown)
      const attempt = attemptSchema.parse(JSON.parse(attemptJson) as unknown)
      const implementation = implementationSchema.parse(
        JSON.parse(plan.implementationJson) as unknown,
      )
      if (implementation.kind !== plan.implementationKind) {
        throw new Error('reaction plan implementation kind mismatch')
      }
      const envelope = inputEnvelopeSchema.parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
      const environment = environmentSchema.parse(
        JSON.parse(envelope.executionEnvironmentJson) as unknown,
      )
      const scene =
        deps.workspace === undefined
          ? ({ kind: 'unmanaged' } as const)
          : await deps.workspace.prepare({ planJson: JSON.stringify(plan), attemptJson })
      const taskId = ulid()
      const sourceFields =
        scene.kind === 'repository'
          ? {}
          : environment.kind === 'scratch'
            ? { scratch: true as const }
            : environment.kind === 'cached-repository'
              ? { cachedRepoId: environment.cachedRepoId }
              : { repoGroupId: environment.repoGroupId }
      const sceneDeps =
        scene.kind !== 'repository'
          ? {}
          : {
              internalSource: {
                kind: 'local-path' as const,
                repoPath: scene.workspacePath,
                baseBranch: scene.baselineSha,
              },
              platformInputPaths: scene.platformInputPaths,
              preCreatedWorktree: {
                taskId,
                worktreePath: scene.workspacePath,
                branch: '',
                baseCommit: scene.baselineSha,
                cleanup: { kind: 'borrowed' as const },
              },
            }
      const guide = deps.executionContracts.get(plan.workContractRef)
      const prompt = buildDigitalEmployeeFixedPrompt(plan, attempt, guide)
      const reviewedExecution = envelope.humanReview
      if (reviewedExecution && implementation.kind !== 'agent') {
        throw new Error('implementation plan review requires an Agent implementation')
      }
      const planPrompt = reviewedExecution
        ? buildDigitalEmployeePlanPrompt(plan, attempt, reviewedExecution.documentPath)
        : null
      const startInput: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: `employee:${plan.roundRef}`.slice(0, 255),
        inputs:
          implementation.kind === 'program'
            ? { [EXECUTION_CONTRACT_SCRIPT_INPUT_PORT]: plan.inputEnvelopeJson }
            : reviewedExecution
              ? {
                  [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt,
                  [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]: planPrompt!,
                }
              : { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt },
        maxDurationMs: plan.roundBudgetMs,
        ...sourceFields,
      }
      let snapshotJson: string
      if (implementation.kind === 'agent') {
        const agent = await getAgentById(deps.db, implementation.agentRef.id)
        if (agent === null || agent.updatedAt !== implementation.agentRef.revision) {
          throw new Error(
            `exact agent unavailable: ${implementation.agentRef.id}@${implementation.agentRef.revision}`,
          )
        }
        if (!agent.outputs.includes(DIGITAL_EMPLOYEE_RESULT_PORT)) {
          throw new Error(`agent must expose ${DIGITAL_EMPLOYEE_RESULT_PORT}`)
        }
        if (reviewedExecution === null) {
          snapshotJson = JSON.stringify(
            synthesizeDigitalEmployeeHostSnapshot({ agentId: agent.id, agentName: agent.name }),
          )
        } else {
          const planAgentRef = reviewedExecution.planningTool.implementation.agentRef
          const planAgent = await getAgentById(deps.db, planAgentRef.id)
          if (planAgent === null || planAgent.updatedAt !== planAgentRef.revision) {
            throw new Error(
              `exact implementation plan Agent unavailable: ${planAgentRef.id}@${planAgentRef.revision}`,
            )
          }
          if (!planAgent.outputs.includes(reviewedExecution.artifactPort)) {
            throw new Error(
              `implementation plan Agent must expose ${reviewedExecution.artifactPort}`,
            )
          }
          snapshotJson = JSON.stringify(
            synthesizeReviewedDigitalEmployeeHostSnapshot({
              planAgentId: planAgent.id,
              planAgentName: planAgent.name,
              implementationAgentId: agent.id,
              implementationAgentName: agent.name,
              artifactPort: reviewedExecution.artifactPort,
              reviewTitle: reviewedExecution.title,
              reviewDescription: reviewedExecution.description,
            }),
          )
        }
      } else if (implementation.kind === 'program') {
        const artifactPath = containedArtifact(deps.appHome, implementation.executableArtifactRef)
        if (artifactPath === null || !existsSync(artifactPath)) {
          throw new Error('program executable artifact is unavailable')
        }
        const source = readFileSync(artifactPath, 'utf8')
        if (sha256Hex(source) !== implementation.executableDigest) {
          throw new Error('program executable artifact digest mismatch')
        }
        let parametersJson = '{}'
        if (implementation.parameterValuesRef !== null) {
          const parameterPath = containedArtifact(deps.appHome, implementation.parameterValuesRef)
          if (parameterPath === null || !existsSync(parameterPath)) {
            throw new Error('program parameter artifact is unavailable')
          }
          const parsedParameters = programParametersSchema.parse(
            JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown,
          )
          parametersJson = JSON.stringify(parsedParameters)
        }
        snapshotJson = JSON.stringify(
          synthesizeDigitalEmployeeScriptHostSnapshot({
            inputPort: EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
            language: implementation.runtimeKind,
            script: source,
            dependencies: [],
            env: {
              DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON: parametersJson,
              DIGITAL_EMPLOYEE_TOOL_CONNECTION_REF_JSON: JSON.stringify(plan.connectionRef),
              DIGITAL_EMPLOYEE_TOOL_SLOT: plan.toolSlotRef,
            },
            readonly: false,
          }),
        )
      } else {
        const workflow = deps.db
          .select({ id: workflows.id, version: workflows.version })
          .from(workflows)
          .where(eq(workflows.id, implementation.workflowRef.id))
          .get()
        if (workflow === undefined || workflow.version !== implementation.workflowRef.revision) {
          throw new Error(
            `exact workflow unavailable: ${implementation.workflowRef.id}@${implementation.workflowRef.revision}`,
          )
        }
        const workflowInput: StartTask = {
          ...startInput,
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt },
        }
        const task = await startTask(workflowInput, {
          ...deps.startDeps,
          catalogVisibility: 'internal',
          digitalEmployeeLaunch: {
            actionRunId: plan.roundRef,
            caseId: plan.caseRef.id,
          },
          ...sceneDeps,
          ...(deps.startDeps.launchProvenance === undefined &&
          deps.startDeps.callLaunch === undefined
            ? {
                launchProvenance: {
                  kind: 'direct-json' as const,
                  initiator: 'api' as const,
                },
              }
            : {}),
        })
        return { executionRef: task.id }
      }

      await ensureDigitalEmployeeHostWorkflow(deps.db)
      const task = await startTask(startInput, {
        ...deps.startDeps,
        catalogVisibility: 'internal',
        digitalEmployeeLaunch: {
          actionRunId: plan.roundRef,
          caseId: plan.caseRef.id,
          snapshotJson,
        },
        ...sceneDeps,
        ...(deps.startDeps.launchProvenance === undefined && deps.startDeps.callLaunch === undefined
          ? {
              launchProvenance: {
                kind: 'direct-json' as const,
                initiator: 'api' as const,
              },
            }
          : {}),
      })
      return { executionRef: task.id }
    },

    async inspect(executionRef) {
      const task = deps.db
        .select({
          status: tasks.status,
          roundRef: tasks.digitalEmployeeRoundId,
          inputs: tasks.inputs,
        })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (task === undefined) {
        return resultFailure(executionRef, 'execution-not-found', 'TaskEngine execution is missing')
      }
      if (!isTerminalTaskStatus(task.status)) return { kind: 'pending', executionRef }
      const outcome = await getExecutionOutcome(deps.db, executionRef)
      const output = outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null
      // Contract/output validation is meaningful only after a successful
      // execution. Running it first masks the actual TaskEngine failure (for
      // example a pre-spawn prompt error) as a missing or mismatched derived
      // artifact, which sends both the Case and the user toward the wrong fix.
      if (task.status !== 'done') {
        return resultFailure(
          executionRef,
          `execution-${task.status}`,
          outcome.error?.message ?? outcome.error?.summary ?? `task ended as ${task.status}`,
        )
      }
      const parsedInputs = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(task.inputs) as unknown)
      const planPrompt = parsedInputs[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]
      if (typeof planPrompt === 'string') {
        const expectedMatch = /EXPECTED_ANALYSIS_PLAN_PATH_JSON\n("[^"\\]*(?:\\.[^"\\]*)*")/.exec(
          planPrompt,
        )
        const expectedPath =
          expectedMatch?.[1] === undefined
            ? null
            : z.string().parse(JSON.parse(expectedMatch[1]) as unknown)
        const planOutput = deps.db
          .select({ content: nodeRunOutputs.content })
          .from(nodeRunOutputs)
          .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
          .where(
            and(
              eq(nodeRuns.taskId, executionRef),
              eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID),
              eq(nodeRuns.status, 'done'),
              eq(nodeRunOutputs.portName, 'analysis-plan'),
            ),
          )
          .orderBy(desc(nodeRuns.id))
          .get()
        if (expectedPath === null || planOutput?.content.trim() !== expectedPath) {
          return resultFailure(
            executionRef,
            'implementation-plan-path-mismatch',
            `analysis-plan must publish the exact platform path ${expectedPath ?? '<missing>'}`,
          )
        }
      }
      if (deps.workspace !== undefined && task.roundRef !== null) {
        const validation = await deps.workspace.validate({
          roundRef: task.roundRef,
          taskStatus: task.status,
          outputJson: output,
        })
        if (!validation.ok) {
          return resultFailure(executionRef, validation.errorCode, validation.errorDetail)
        }
      }
      if (output === null) {
        return resultFailure(
          executionRef,
          'execution-output-missing',
          `task did not publish ${DIGITAL_EMPLOYEE_RESULT_PORT}`,
        )
      }
      return { kind: 'completed', executionRef, outputJson: output }
    },

    inspectHumanReview(executionRef) {
      return inspectDigitalEmployeeHumanReviewState(deps.db, executionRef)
    },

    async cancel(executionRef) {
      const task = deps.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (task === undefined || isTerminalTaskStatus(task.status)) return
      await cancelTask(deps.db, executionRef)
    },
  }
}
