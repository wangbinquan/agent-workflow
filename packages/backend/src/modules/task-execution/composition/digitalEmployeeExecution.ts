import { eq } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'

import { isTerminalTaskStatus, type StartTask } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import type { DigitalEmployeeExecutionParticipant } from '../public/participants'
import { getAgentById } from '@/services/agent'
import { getExecutionOutcome } from '@/services/execution/executor'
import { cancelTask, startTask, type StartTaskDeps } from '@/services/task'
import { sha256Hex } from '@/util/hash'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
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
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    toolSlotRef: z.string().min(1),
    connectionRef: exactRefSchema.nullable(),
    implementationRef: exactRefSchema.nullable(),
    implementationKind: z.enum(['agent', 'workflow', 'program']),
    implementationJson: z.string().min(2),
    inputEnvelopeJson: z.string().min(2),
    outputSchemaId: z.string().min(1),
    semanticValidatorId: z.string().min(1),
    roundBudgetMs: z.number().int().positive(),
  })
  .passthrough()

const environmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scratch') }).strict(),
  z.object({ kind: z.literal('cached-repository'), cachedRepoId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('repository-group'), repoGroupId: z.string().min(1) }).strict(),
])

const inputEnvelopeSchema = z.object({ executionEnvironmentJson: z.string().min(2) }).passthrough()

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
    | 'outputSchemaId'
    | 'roundRef'
    | 'executionNonce'
    | 'toolSlotRef'
    | 'semanticValidatorId'
    | 'inputEnvelopeJson'
  >,
  attempt: Pick<z.infer<typeof attemptSchema>, 'previousError'>,
): string {
  return [
    'You are executing one frozen Digital Employee work item.',
    'Do not run git, commit, push, merge, approve, call a code host, or choose the next action.',
    'Only modify business files required by the supplied work contract.',
    `Return only the exact JSON envelope for output schema ${plan.outputSchemaId}.`,
    `Copy schemaVersion=1, roundRef=${JSON.stringify(plan.roundRef)}, and executionNonce=${JSON.stringify(plan.executionNonce)} exactly.`,
    `The platform selected tool slot ${JSON.stringify(plan.toolSlotRef)}; do not select or invoke another slot.`,
    'The envelope must contain exactly these top-level fields: schemaVersion, roundRef, executionNonce, status, summary, contextPatches, effectSuggestions, artifactRefs.',
    'status is one of ok, needs-input, blocked. contextPatches is an array of {contextId,contextTypeId,schemaVersion,expectedRevision,lifecycleState,stateJson,artifactRefs}.',
    'Never wrap the JSON in Markdown and never add prose before or after it.',
    `Semantic validator: ${plan.semanticValidatorId}.`,
    ...(attempt.previousError === null
      ? []
      : [
          '',
          `The previous exact-envelope attempt was rejected: ${attempt.previousError}`,
          'Correct the reported contract violation and return a new complete envelope.',
        ]),
    '',
    plan.inputEnvelopeJson,
  ].join('\n')
}

export function composeDigitalEmployeeExecution(deps: {
  readonly db: DbClient
  readonly appHome: string
  readonly startDeps: StartTaskDeps
  readonly workspace?: DigitalEmployeeWorkspacePort
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
      const prompt = buildDigitalEmployeeFixedPrompt(plan, attempt)
      const startInput: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: `employee:${plan.roundRef}`.slice(0, 255),
        inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt },
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
        snapshotJson = JSON.stringify(
          synthesizeDigitalEmployeeHostSnapshot({ agentId: agent.id, agentName: agent.name }),
        )
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
          digitalEmployeeLaunch: { actionRunId: plan.roundRef },
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
        digitalEmployeeLaunch: { actionRunId: plan.roundRef, snapshotJson },
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
        .select({ status: tasks.status, roundRef: tasks.digitalEmployeeRoundId })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (task === undefined) {
        return resultFailure(executionRef, 'execution-not-found', 'TaskEngine execution is missing')
      }
      if (!isTerminalTaskStatus(task.status)) return { kind: 'pending', executionRef }
      const outcome = await getExecutionOutcome(deps.db, executionRef)
      const output = outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null
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
      if (task.status !== 'done') {
        return resultFailure(
          executionRef,
          `execution-${task.status}`,
          outcome.error?.message ?? outcome.error?.summary ?? `task ended as ${task.status}`,
        )
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
