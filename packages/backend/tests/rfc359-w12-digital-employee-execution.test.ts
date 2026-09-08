// RFC-359 W12: exercise both production Digital Employee execution composers
// through the complete selected TaskEngine and a real mock-opencode child.
// Task, node, output, owner and usage rows are produced by the runtime itself.
import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import {
  agents,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionIntents,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { developmentExecutionContractRegistrations } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeExecutionContract,
  createPostgresqlExecutionContractResourceAdapter,
} from '@/modules/execution-contract/composition'
import { executionContractGuideSchema } from '@/modules/execution-contract/domain/model'
import { composePostgresqlResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import {
  composeDigitalEmployeeExecution,
  composePostgresqlDigitalEmployeeExecution,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import type { DigitalEmployeeWorkspacePort } from '@/modules/task-execution/composition/required-ports'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import type { TaskDriveRuntimeOptions } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { DigitalEmployeeExecutionResult } from '@/modules/task-execution/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { readTaskResourceUsage } from '@/services/limits'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const CONTRACT = { contractId: 'development.analyze-implement', version: 1 }
const registration = developmentExecutionContractRegistrations.find(
  (item) =>
    item.contractRef.contractId === CONTRACT.contractId &&
    item.contractRef.version === CONTRACT.version,
)!
const guide = executionContractGuideSchema.parse(JSON.parse(registration.guideJson))

function workflow(agentId: string, agentName: string): WorkflowDefinition {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [
      {
        kind: 'text',
        key: DIGITAL_EMPLOYEE_PROMPT_KEY,
        label: 'Digital employee prompt',
        required: true,
      },
    ],
    nodes: [
      { id: 'input', kind: 'input', inputKey: DIGITAL_EMPLOYEE_PROMPT_KEY },
      { id: 'agent', kind: 'agent-single', agentId, agentName },
      {
        id: 'output',
        kind: 'output',
        ports: [
          {
            name: DIGITAL_EMPLOYEE_RESULT_PORT,
            bind: { nodeId: 'agent', portName: DIGITAL_EMPLOYEE_RESULT_PORT },
          },
        ],
      },
    ],
    edges: [
      {
        id: 'prompt-to-agent',
        source: { nodeId: 'input', portName: DIGITAL_EMPLOYEE_PROMPT_KEY },
        target: { nodeId: 'agent', portName: DIGITAL_EMPLOYEE_PROMPT_KEY },
      },
      {
        id: 'result-to-output',
        source: { nodeId: 'agent', portName: DIGITAL_EMPLOYEE_RESULT_PORT },
        target: { nodeId: 'output', portName: DIGITAL_EMPLOYEE_RESULT_PORT },
      },
    ],
  }
}

describeEachProvider('RFC-359 W12 Digital Employee real execution', (harness) => {
  for (const kind of ['workflow', 'agent'] as const) {
    test(`${kind} plan launches the selected runtime, completes and can be inspected by a fresh participant`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-employee-execution-'))
      const workspacePath = join(appHome, 'workspace')
      const capture = join(appHome, 'invocations.jsonl')
      const roundRef = `round-${ulid()}`
      const caseId = `case-${ulid()}`
      const executionNonce = '7'.repeat(64)
      const output = JSON.stringify({
        ...JSON.parse(guide.output.exampleJson),
        roundRef,
        executionNonce,
        summary: `${kind} completed through the selected database`,
      })
      const overrides = {
        AGENT_WORKFLOW_HOME: appHome,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ [DIGITAL_EMPLOYEE_RESULT_PORT]: output }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: capture,
      }
      const previous = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]]),
      )
      Object.assign(process.env, overrides)
      let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
      try {
        mkdirSync(workspacePath)
        await runGit(workspacePath, ['init', '-q', '-b', 'main'])
        await runGit(workspacePath, ['config', 'user.name', 'Employee Execution Fixture'])
        await runGit(workspacePath, ['config', 'user.email', 'employee-execution@example.test'])
        writeFileSync(join(workspacePath, 'README.md'), '# Digital employee execution fixture\n')
        await runGit(workspacePath, ['add', 'README.md'])
        await runGit(workspacePath, ['commit', '-q', '-m', 'fixture'])
        const baselineSha = (await runGit(workspacePath, ['rev-parse', 'HEAD'])).stdout.trim()
        const userId = ulid()
        const agentId = ulid()
        const workflowId = ulid()
        const agentName = `employee-execution-${kind}`
        const now = Date.now()
        await harness.db.insert(users).values({
          id: userId,
          username: `employee-${userId}`,
          displayName: 'Employee Execution Fixture',
          gitName: 'Employee Execution Fixture',
          email: 'employee-execution@example.test',
          role: 'admin',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        await harness.db.insert(agents).values({
          id: agentId,
          name: agentName,
          description: 'Real subprocess fixture',
          outputs: JSON.stringify([DIGITAL_EMPLOYEE_RESULT_PORT]),
          permission: '{}',
          skills: '[]',
          frontmatterExtra: '{}',
          bodyMd: 'Return the requested digital employee result.',
          createdAt: now,
          updatedAt: now,
        })
        const definition = workflow(agentId, agentName)
        await harness.db.insert(workflows).values({
          id: workflowId,
          name: 'Employee execution workflow',
          definition: JSON.stringify(definition),
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        const runConfig: TaskDriveRuntimeOptions = {
          appHome,
          binaryOverride: [process.execPath, 'run', MOCK_OPENCODE],
          defaultNodeRetries: 0,
          defaultPerNodeTimeoutMs: 20_000,
        }
        execution = await createEachProviderTaskExecution(harness, runConfig, userId)
        const { provider, actor, identityAccess, launchResources } = execution
        const prepared: Array<{ planJson: string; attemptJson: string }> = []
        const validated: Array<{
          roundRef: string
          taskStatus: string
          outputJson: string | null
        }> = []
        const workspace: DigitalEmployeeWorkspacePort = {
          async prepare(input) {
            prepared.push(input)
            return { kind: 'repository', workspacePath, baselineSha, platformInputPaths: [] }
          },
          async validate(input) {
            validated.push(input)
            if (
              input.roundRef !== roundRef ||
              input.taskStatus !== 'done' ||
              input.outputJson !== output
            ) {
              return {
                ok: false,
                errorClass: 'semantic',
                errorCode: 'employee-fixture-output-mismatch',
                errorDetail: 'The completed runtime output did not match the frozen round.',
              }
            }
            return { ok: true }
          },
        }
        const executionContracts =
          provider.provider === 'sqlite'
            ? composeExecutionContract({
                db: harness.db as unknown as DbClient,
                appHome,
                registrations: developmentExecutionContractRegistrations,
              })
            : composeExecutionContract({
                resources: createPostgresqlExecutionContractResourceAdapter(
                  harness.db as unknown as PostgresqlDatabaseClient,
                ),
                appHome,
                registrations: developmentExecutionContractRegistrations,
              })
        const compose = () => {
          if (provider.provider === 'sqlite') {
            const db = harness.db as unknown as DbClient
            return composeDigitalEmployeeExecution({
              db,
              appHome,
              executionContracts,
              workspace,
              startDeps: {
                db,
                ...runConfig,
                schedulerDriver: provider.runtime.schedulerDriver,
                taskRecoveryOperations: provider.recovery,
                identityAccess,
                launchResources,
                actorUserId: actor.user.id,
                awaitScheduler: true,
              },
            })
          }
          const db = harness.db as unknown as PostgresqlDatabaseClient
          const limits = composePostgresqlResourceLimitOperations({
            db,
            cancelTask: (taskId) =>
              provider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
          })
          return composePostgresqlDigitalEmployeeExecution({
            appHome,
            actor,
            resourceAuthorityFor: () => launchResources,
            launch: provider.routeLaunch.workflow,
            tasks: provider.routes.tasks,
            readModels: provider.readModels,
            resourceUsage: { read: (taskId) => readTaskResourceUsage(limits, taskId) },
            agents: {
              async get(id) {
                const row = (
                  await db
                    .select({
                      id: agents.id,
                      name: agents.name,
                      updatedAt: agents.updatedAt,
                      outputs: agents.outputs,
                    })
                    .from(agents)
                    .where(eq(agents.id, id))
                    .limit(1)
                )[0]
                return row === undefined
                  ? null
                  : { ...row, outputs: JSON.parse(row.outputs) as string[] }
              },
            },
            workflows: {
              async get(id) {
                const row = (
                  await db
                    .select({
                      id: workflows.id,
                      name: workflows.name,
                      version: workflows.version,
                      definition: workflows.definition,
                    })
                    .from(workflows)
                    .where(eq(workflows.id, id))
                    .limit(1)
                )[0]
                return row === undefined
                  ? null
                  : {
                      ...row,
                      definition: WorkflowDefinitionSchema.parse(JSON.parse(row.definition)),
                    }
              },
            },
            executionMetadata: {
              async load(taskId) {
                return (
                  (
                    await db
                      .select({
                        roundRef: tasks.digitalEmployeeRoundId,
                        autoRecoverySuspended: tasks.autoRecoverySuspended,
                      })
                      .from(tasks)
                      .where(eq(tasks.id, taskId))
                      .limit(1)
                  )[0] ?? null
                )
              },
            },
            executionContracts,
            workspace,
          })
        }
        const plan = {
          schemaVersion: 1,
          caseRef: { id: caseId, revision: 1 },
          roundRef,
          executionNonce,
          toolSlotRef: 'default',
          connectionRef: null,
          implementationRef: { id: `implementation-${kind}`, revision: 1 },
          implementationKind: kind,
          implementationJson: JSON.stringify(
            kind === 'workflow'
              ? { kind, workflowRef: { id: workflowId, revision: 1 } }
              : { kind, agentRef: { id: agentId, revision: now } },
          ),
          inputEnvelopeJson: JSON.stringify({
            ...JSON.parse(guide.input.exampleJson),
            roundRef,
            executionNonce,
            workInstructions: 'Produce a real persisted digital employee result.',
            executionEnvironmentJson: JSON.stringify({ kind: 'scratch' }),
          }),
          inputSchemaId: guide.input.schemaId,
          outputSchemaId: guide.output.schemaId,
          workContractRef: CONTRACT,
          semanticValidatorId: 'development.analyze-implement.validator',
          allowedEffectKinds: [],
          roundBudgetMs: 30_000,
          maxTotalTokens: 10_000,
        }
        const attempt = JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null })
        expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])
        const participant = compose()
        const launched = await participant.launch(JSON.stringify(plan), attempt)
        const [task] = await harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, launched.executionRef))
        expect(task, task?.errorMessage ?? undefined).toMatchObject({
          status: 'done',
          errorMessage: null,
          errorSummary: null,
          ownerUserId: userId,
          catalogVisibility: 'internal',
          digitalEmployeeCaseId: caseId,
          digitalEmployeeRoundId: roundRef,
          workflowId: kind === 'workflow' ? workflowId : DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
          maxDurationMs: 30_000,
          maxTotalTokens: 10_000,
        })
        expect(task?.finishedAt).toBeGreaterThanOrEqual(now)
        const runs = await harness.db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, launched.executionRef))
        expect(runs).toHaveLength(3)
        expect(runs.every((run) => run.status === 'done')).toBe(true)
        const snapshot = WorkflowDefinitionSchema.parse(JSON.parse(task!.workflowSnapshot))
        const agentNode = snapshot.nodes.find((node) => node.kind === 'agent-single')!
        expect(agentNode).toMatchObject({ agentId })
        const agentRun = runs.find((run) => run.nodeId === agentNode.id)
        expect(agentRun?.exitCode).toBe(0)
        const outputNode = snapshot.nodes.find((node) => node.kind === 'output')!
        const outputRun = runs.find((run) => run.nodeId === outputNode.id)!
        expect(
          await harness.db
            .select({ port: nodeRunOutputs.portName, content: nodeRunOutputs.content })
            .from(nodeRunOutputs)
            .where(eq(nodeRunOutputs.nodeRunId, outputRun.id)),
        ).toEqual([{ port: DIGITAL_EMPLOYEE_RESULT_PORT, content: output }])
        const invocations = readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(invocations).toHaveLength(1)
        expect(invocations[0].prompt).toContain(roundRef)
        expect(invocations[0].prompt).toContain(executionNonce)
        expect(invocations[0].prompt).toContain('Produce a real persisted digital employee result.')
        expect(await execution.persistence.ownership.read(launched.executionRef)).toMatchObject({
          state: 'released',
        })
        expect(execution.isActive(launched.executionRef)).toBe(false)
        expect(
          await harness.db
            .select({ kind: taskExecutionIntents.kind, state: taskExecutionIntents.state })
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.taskId, launched.executionRef)),
        ).toEqual([{ kind: 'launch', state: 'completed' }])
        const expected = {
          kind: 'completed',
          executionRef: launched.executionRef,
          outputJson: output,
          metering: {
            sourceRef: `task:${launched.executionRef}`,
            durationMs: task!.runningMs,
            totalTokens: runs.reduce((sum, run) => sum + (run.tokTotal ?? 0), 0),
          },
        } satisfies DigitalEmployeeExecutionResult
        expect(await participant.inspect(launched.executionRef)).toEqual(expected)
        expect(await compose().inspect(launched.executionRef)).toEqual(expected)
        expect(prepared).toHaveLength(1)
        expect(JSON.parse(prepared[0]!.planJson)).toEqual(plan)
        expect(prepared[0]!.attemptJson).toBe(attempt)
        expect(validated).toEqual(
          Array.from({ length: 2 }, () => ({ roundRef, taskStatus: 'done', outputJson: output })),
        )
        expect(existsSync(join(workspacePath, 'README.md'))).toBe(true)
      } finally {
        execution?.shutdown()
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(appHome, { recursive: true, force: true })
      }
    }, 60_000)
  }
})
