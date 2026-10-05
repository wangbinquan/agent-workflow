import type { Agent } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { describeEachProvider } from './helpers/eachProvider'
import { workflows, tasks, nodeRuns, nodeRunOutputs } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '../src/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeLocalInvocationObservations } from '../src/modules/run-observability/composition/localInvocations'
import { composeObservationUsageSource } from '../src/modules/task-execution/composition/observationUsageSource'
import { sqliteMemoryInjectionQueries } from './helpers/memoryInjection'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { runSelectedTaskAgent } from '../src/modules/task-execution/composition/taskAgentRun'
import { createTaskAgentMaterialPreparation } from '../src/modules/task-execution/composition/taskAgentMaterialPreparation'
import { createAgentInvocationPreparation } from '../src/modules/task-execution/composition/agentInvocationPreparation'
import type { TaskAgentRunPolicy } from '../src/modules/task-execution/application/ports/taskAgentRun'
import type { TaskAgentRunPurpose } from '../src/modules/task-execution/application/ports/taskAgentMaterial'
import type { AgentInvocationBinding } from '../src/modules/task-execution/application/ports/agentInvocation'
import type { AgentExecutionParticipants } from '../src/modules/task-execution/application/ports/agentExecutionBinding'
import type { ExecutionEffectRequest } from '../src/modules/task-execution/application/ports/executionEffect'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '../src/modules/runtime-management/public/participants'
import type { RuntimeKind } from '../src/modules/runtime-management/public/types'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import { getRuntimeDriver } from '../src/services/runtime'
import { createLogger } from '../src/util/log'

function agent(): Agent {
  return {
    id: ulid(),
    name: 'selected-task-agent',
    description: '',
    outputs: ['summary', 'closed'],
    branchPorts: ['closed'],
    outputKinds: { summary: 'path<md>', closed: 'path<md>' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '原角色正文',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}
function noRead(): never {
  throw new Error('unselected Task operation invoked')
}

describeEachProvider('RFC-370 selected complete Task core', (harness) => {
  for (const rejection of ['mount', 'compile'] as const) {
    test(`${rejection}: whole Task core preserves the original material failure boundary`, async () => {
      const db = harness.db,
        taskId = ulid(),
        nodeRunId = ulid(),
        workflowId = ulid()
      await db.insert(workflows).values({
        id: workflowId,
        name: 'selected-rejection',
        definition: '{}',
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(tasks).values({
        id: taskId,
        name: 'selected-rejection',
        workflowId,
        workflowSnapshot: '{}',
        repoPath: 'repo:declaration',
        worktreePath: 'workspace:metadata',
        baseBranch: 'main',
        branch: 'task',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
      })
      await db.insert(nodeRuns).values({
        id: nodeRunId,
        taskId,
        nodeId: 'n1',
        agentName: 'selected-task-agent',
        iteration: 0,
        retryIndex: 0,
        status: 'pending',
      })
      const selectedError = new Error(`selected ${rejection} rejection`)
      const calls: string[] = []
      const workspace: AgentMaterialWorkspace = {
        workspace: { owner: 'source-control', reference: 'working:selected', version: 1 },
        runContent: { owner: 'runtime-management', reference: 'run:selected', version: 1 },
        retainedRef: 'retained:selected',
        prepare: noRead,
        discard() {
          calls.push('discard')
        },
      }
      const material = createTaskAgentMaterialPreparation({
        preparation: {
          workspace,
          async compile() {
            calls.push('compile')
            throw selectedError
          },
        },
        resources: {
          injection: { skills: [], plugins: [] },
          prepareMounts() {
            calls.push('mount')
            if (rejection === 'mount') throw selectedError
            return [workspace.workspace]
          },
        },
        diagnostics: {
          readDeclaredMcpServers: noRead,
          reportSpawn: noRead,
          detectPluginLoadFailure: noRead,
        },
      })
      const purpose: TaskAgentRunPurpose = {
        workspace,
        nodeRunPrompts: {
          async store() {
            return { promptText: null, promptPath: 'prompt:selected' }
          },
          read: noRead,
        },
        portArtifacts: { archive: noRead, read: noRead },
        outputWorkspaceRef: workspace.workspace.reference,
        outputValidation: { resolve: noRead },
        gitControlObservation: { capture: noRead },
        selectMaterial() {
          return material
        },
        bindExecutionParticipants: noRead,
      }
      const policy: TaskAgentRunPolicy = {
        taskId,
        nodeRunId,
        nodeId: 'n1',
        agent: agent(),
        inputs: {},
        templateMeta: { taskId, repoPath: 'repo:declaration', baseBranch: 'main' },
        runtime: 'opencode',
        persistence: createTaskExecutionPersistence(db),
        observationInvocations: composeLocalInvocationObservations(
          db,
          composeObservationUsageSource(db),
        ),
        memoryInjectionQueries: sqliteMemoryInjectionQueries(db),
        runtimeRegistry: composeRuntimeRegistryOperations(db),
        runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
        log: createLogger('selected-task-rejection'),
      }
      if (rejection === 'mount') {
        await expect(runSelectedTaskAgent(policy, purpose)).rejects.toBe(selectedError)
        expect(calls).toEqual(['mount'])
      } else {
        const result = await runSelectedTaskAgent(policy, purpose)
        expect(result.status).toBe('failed')
        expect(result.errorMessage).toBe('spawn opencode failed: selected compile rejection')
        expect(result.exitCode).toBeNull()
        expect(result.outputs).toEqual({})
        expect(calls).toEqual(['mount', 'compile'])
      }
      const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
      expect(row?.status).toBe(rejection === 'mount' ? 'running' : 'failed')
      expect(row?.errorMessage).toBe(
        rejection === 'mount' ? null : 'spawn opencode failed: selected compile rejection',
      )
    })
  }
  for (const runtime of ['opencode', 'claude-code'] as const) {
    test(`${runtime}: compiles once, writes receipt before output, validates and archives the same selected workspace`, async () => {
      const db = harness.db,
        taskId = ulid(),
        nodeRunId = ulid(),
        workflowId = ulid()
      await db
        .insert(workflows)
        .values({ id: workflowId, name: 'selected', definition: '{}', createdAt: 1, updatedAt: 1 })
      await db.insert(tasks).values({
        id: taskId,
        name: 'selected',
        workflowId,
        workflowSnapshot: '{}',
        repoPath: 'repo:declaration',
        worktreePath: 'workspace:metadata',
        baseBranch: 'main',
        branch: 'task',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
      })
      await db.insert(nodeRuns).values({
        id: nodeRunId,
        taskId,
        nodeId: 'n1',
        agentName: 'selected-task-agent',
        iteration: 0,
        retryIndex: 0,
        status: 'pending',
      })
      const calls: string[] = [],
        intents: AgentMaterialIntent[] = []
      const log = createLogger('selected-task-test')
      const workspace: AgentMaterialWorkspace = {
        workspace: { owner: 'source-control', reference: 'workspace:selected-g17', version: 17 },
        runContent: { owner: 'runtime-management', reference: 'run:selected-g11', version: 11 },
        retainedRef: 'retained:selected',
        prepare: noRead,
        discard() {
          expect(this).toBe(workspace)
          calls.push('discard')
        },
      }
      let selectedParticipants: AgentExecutionParticipants
      const prepared = {
        materialRef: 'material:selected-v2',
        declared: emptyDeclaredManifest(),
        evidenceCapabilities: {
          usageNormalizer: false,
          nativeUsageCapture: false,
          spanCapture: false,
          sessionCapture: false,
          inventory: false,
          finalEvents: false,
          liveCapture: false,
          sessionSinkCapture: false,
        },
      }
      let submitted: ExecutionEffectRequest | undefined
      const binding: AgentInvocationBinding = {
        materialRef: prepared.materialRef,
        declared: prepared.declared,
        workspace,
        protocol: {
          kind: runtime,
          capabilities: getRuntimeDriver(runtime).capabilities,
          parseEvent(line) {
            calls.push('parse')
            return { kind: 'text', text: line, rawLine: line }
          },
        },
        evidence: { captureSessions: noRead },
        lifecycle: {
          cleanup() {
            calls.push('material-cleanup')
          },
        },
        bindExecution(participants) {
          expect(participants).toBe(selectedParticipants)
          calls.push('bind-execution')
          return {
            executionRef: 'execution:selected-e4',
            materialRef: prepared.materialRef,
            workspaceRef: workspace.workspace.reference,
            projection: {
              describe() {
                return {
                  requestHash: 'selected-request',
                  resourceKeys: ['workspace:selected-g17'],
                  recoveryClass: 'selected-recovery',
                  classifierVersion: 'selected-v1',
                  transportPolicyVersion: 'selected-v1',
                }
              },
              async recordSpawnReceipt() {
                calls.push('effect-receipt')
              },
              settlementReceipt() {
                return 'selected-settled'
              },
            },
            async acknowledgeOwner() {
              calls.push('owner-ack')
            },
            async recordTaskReceipt(receipt, runId) {
              expect(receipt.executionRef).toBe('execution:selected-e4')
              expect(runId).toBe(nodeRunId)
              calls.push('task-receipt')
            },
            reportUnreaped: noRead,
            unreapedMessage: noRead,
            effect: {
              async submit(request) {
                submitted = request
                expect(request.materialRef).toBe(prepared.materialRef)
                expect(request.workspaceRef).toBe(workspace.workspace.reference)
                await request.beforeStart?.()
                calls.push('before-start-ack')
                await request.onStarted?.({
                  executionRef: request.executionRef,
                  startedAt: Date.now(),
                })
                calls.push('activated')
                await request.capture?.onStdoutLine?.(
                  '<workflow-output>\n<port name="summary">report.md</port>\n<port name="closed" active="false">skip reason</port>\n</workflow-output>',
                )
                await request.capture?.onStdoutChunkEnd?.()
                await request.cleanup?.()
                return {
                  executionRef: request.executionRef,
                  outcome: 'ok',
                  exitCode: 0,
                  rawStdout: '',
                  stderrTail: '',
                  durationMs: 1,
                }
              },
            },
          }
        },
      }
      const preparation = createAgentInvocationPreparation({
        workspace,
        compiler: {
          async compile(intent) {
            intents.push(intent)
            calls.push('compile')
            return prepared
          },
        },
        bind(material) {
          expect(material).toBe(prepared)
          calls.push('bind-material')
          return binding
        },
      })
      const material = createTaskAgentMaterialPreparation({
        preparation,
        resources: {
          injection: {
            skills: [
              {
                name: 's1',
                sourceKind: 'managed',
                content: { owner: 'resource-catalog', reference: 'skill:s1-v7', version: 7 },
              },
            ],
            plugins: [],
          },
          runtimeBinding: {
            owner: 'runtime-management',
            reference: 'runtime:selected-v3',
            version: 3,
          },
          prepareMounts() {
            calls.push('mounts')
            return [workspace.workspace]
          },
        },
        diagnostics: {
          readDeclaredMcpServers(compiled) {
            expect(compiled.materialRef).toBe(prepared.materialRef)
            calls.push('declared-mcps')
            return []
          },
          reportSpawn(compiled) {
            expect(compiled.materialRef).toBe(prepared.materialRef)
            calls.push('spawn-report')
          },
          detectPluginLoadFailure() {
            return null
          },
        },
      })
      const purpose: TaskAgentRunPurpose = {
        workspace,
        outputWorkspaceRef: workspace.workspace.reference,
        nodeRunPrompts: {
          async store() {
            calls.push('prompt-store')
            return { promptText: null, promptPath: 'prompt:selected-g11' }
          },
          read: noRead,
        },
        portArtifacts: {
          async archive(request) {
            expect(request.items).toEqual([
              {
                source: {
                  workspaceRef: workspace.workspace.reference,
                  relativePath: 'docs/report.md',
                },
                sourcePath: 'docs/report.md',
              },
            ])
            calls.push('archive')
            return {
              archiveJson: JSON.stringify({
                v: 1,
                items: [
                  {
                    path: 'docs/report.md',
                    file: 'archive:selected-v8',
                    size: 12,
                    truncated: false,
                  },
                ],
              }),
              portFilePaths: ['docs/report.md'],
            }
          },
          read: noRead,
        },
        outputValidation: {
          async resolve(request) {
            expect(request.workspaceRef).toBe(workspace.workspace.reference)
            expect(request.port).toBe('summary')
            calls.push('validate')
            return { body: '# report', sourcePath: 'docs/report.md' }
          },
        },
        gitControlObservation: { capture: noRead },
        selectMaterial(selected: RuntimeKind, selectedWorkspace) {
          expect(selected).toBe(runtime)
          expect(selectedWorkspace).toBe(workspace)
          calls.push('select-material')
          return material
        },
        bindExecutionParticipants(input) {
          expect(input.persistence).toBe(policy.persistence.effects)
          expect(input.nodeExecution()).toBe(policy.persistence.nodeExecution)
          calls.push('task-participant')
          const issued = {
            taskEffect: Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>,
          }
          selectedParticipants = issued
          return issued
        },
      }
      const policy: TaskAgentRunPolicy = {
        taskId,
        nodeRunId,
        nodeId: 'n1',
        agent: agent(),
        inputs: {},
        templateMeta: { taskId, repoPath: 'repo:declaration', baseBranch: 'main' },
        runtime,
        persistence: createTaskExecutionPersistence(db),
        observationInvocations: composeLocalInvocationObservations(
          db,
          composeObservationUsageSource(db),
        ),
        memoryInjectionQueries: sqliteMemoryInjectionQueries(db),
        runtimeRegistry: composeRuntimeRegistryOperations(db),
        runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
        log,
      }
      // These legacy-only inputs must never be read by selected execution.
      for (const name of [
        'appHome',
        'worktreePath',
        'runtimeBinary',
        'binaryOverride',
        'skills',
        'plugins',
      ])
        Object.defineProperty(policy, name, { get: noRead })
      expect(calls).toEqual([])
      const result = await runSelectedTaskAgent(policy, purpose)
      expect(result.status).toBe('done')
      expect(result.outputs).toEqual({ summary: 'docs/report.md', closed: 'skip reason' })
      expect(result.inactiveOutputs).toEqual(['closed'])
      expect(result.portFilePaths).toEqual(['docs/report.md'])
      expect(intents).toHaveLength(1)
      expect(intents[0]?.workspace).toBe(workspace.workspace)
      expect(intents[0]?.runContent).toBe(workspace.runContent)
      expect(intents[0]?.runtimeBinding?.reference).toBe('runtime:selected-v3')
      expect(intents[0]?.resolvedProfiles.map(([name]) => name)).toEqual(['selected-task-agent'])
      expect(intents[0]?.prompt).toBe(result.prompt)
      expect(calls.filter((call) => call === 'bind-material')).toHaveLength(1)
      expect(calls.indexOf('task-receipt')).toBeLessThan(calls.indexOf('activated'))
      expect(calls.indexOf('owner-ack')).toBeLessThan(calls.indexOf('activated'))
      expect(calls.indexOf('parse')).toBeGreaterThan(calls.indexOf('activated'))
      expect(calls.indexOf('validate')).toBeLessThan(calls.indexOf('archive'))
      expect(calls.filter((call) => call === 'validate')).toHaveLength(1)
      expect(submitted).not.toHaveProperty('cmd')
      expect(submitted).not.toHaveProperty('env')
      expect(submitted).not.toHaveProperty('pid')
      const rows = await db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
      expect(rows.map((row) => row.portName).sort()).toEqual(['closed', 'summary'])
    })
  }
})
