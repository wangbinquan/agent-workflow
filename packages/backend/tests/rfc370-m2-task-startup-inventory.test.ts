// The real Task core persists transported runtime facts while still running;
// presentation-only observation failures do not change the business result.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Agent } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeRunObservationCalls } from '@/modules/run-observability/composition/runObservation'
import { sqliteMemoryInjectionQueries } from './helpers/memoryInjection'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { runSelectedTaskAgent } from '@/modules/task-execution/composition/taskAgentRun'
import { createTaskAgentMaterialPreparation } from '@/modules/task-execution/composition/taskAgentMaterialPreparation'
import type { AgentMaterialWorkspace } from '@/modules/runtime-management/public/participants'
import type { TaskAgentRunPurpose } from '@/modules/task-execution/application/ports/taskAgentMaterial'
import type { AgentInvocationBinding } from '@/modules/task-execution/application/ports/agentInvocation'
import type { AgentExecutionParticipants } from '@/modules/task-execution/application/ports/agentExecutionBinding'
import type { HostedStartupInventory } from '@/platform/crewstation/startupInventory'
import { hostedEventRecord } from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { getRuntimeDriver } from '@/services/runtime'
import { createLogger } from '@/util/log'

describeEachProvider('RFC-370 Task startup inventory stream', (harness) => {
  for (const runtime of ['opencode', 'claude-code'] as const)
    for (const state of ['verified', 'unavailable', 'malformed'] as const)
      test(`${runtime}/${state}: same Task pipeline preserves live/final observation and excludes synthetic chat text`, async () => {
        const db = harness.db,
          taskId = ulid(),
          nodeRunId = ulid(),
          workflowId = ulid()
        const { workflows, tasks, nodeRuns, nodeRunEvents } = tablesOf(db)
        await insertOne(db, workflows, {
          id: workflowId,
          name: 'inventory',
          definition: '{}',
          createdAt: 1,
          updatedAt: 1,
        })
        await insertOne(db, tasks, {
          id: taskId,
          workflowId,
          name: 'inventory',
          workflowSnapshot: '{}',
          repoPath: 'repo:declared',
          worktreePath: 'workspace:declared',
          baseBranch: 'main',
          branch: 'task',
          status: 'running',
          inputs: '{}',
          startedAt: 1,
        })
        await insertOne(db, nodeRuns, {
          id: nodeRunId,
          taskId,
          nodeId: 'n1',
          iteration: 0,
          retryIndex: 0,
          status: 'pending',
        })
        const agent: Agent = {
          id: ulid(),
          name: 'inventory',
          description: '',
          outputs: ['summary'],
          branchPorts: [],
          outputKinds: { summary: 'path<md>' },
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: 'produce a report',
          schemaVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        }
        const workspace: AgentMaterialWorkspace = {
          workspace: { owner: 'source-control', reference: 'workspace:declared', version: 1 },
          runContent: { owner: 'runtime-management', reference: 'run:declared', version: 1 },
          retainedRef: 'run:declared',
          prepare: async () => undefined,
          discard: async () => undefined,
        }
        const declared = {
          ...emptyDeclaredManifest(),
          mcpServers: ['actual', 'missing'],
          skills: ['declared-skill'],
        }
        const report: HostedStartupInventory =
          state === 'verified'
            ? {
                version: 1,
                state,
                source: runtime === 'opencode' ? 'opencode-inventory' : 'claude-init',
                mcpServers: [{ name: 'actual', status: 'connected' }],
                skills: [],
              }
            : { version: 1, state, reason: 'inventory-test-failure' }
        const record = hostedEventRecord(
          {
            type: 'startup-inventory',
            data: report,
            taskId: 'parent',
            subtaskId: 'child',
            attempt: 1,
            cursor: '1',
            sourceEventId: 'event',
            occurredAt: new Date(1000).toISOString(),
          },
          runtime,
        )
        let eager: unknown,
          settled = false
        const binding: AgentInvocationBinding = {
          materialRef: 'material',
          declared,
          workspace,
          protocol: {
            kind: runtime,
            capabilities: {
              ...getRuntimeDriver(runtime).capabilities,
              startupObservation: 'init-event',
              observationRequiresFreshRun: false,
            },
            parseEvent: () => null,
          },
          evidence: { captureSessions: async () => undefined },
          lifecycle: {},
          async execute(request, sink) {
            await request.beforeStart?.()
            await sink.record({ ...record, sourceKey: 'original:1' })
            const [live] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
            expect(live?.status).toBe('running')
            eager = JSON.parse(live!.runtimeInventoryJson!)
            // A replay must retain the first report, including a failure.
            await sink.record({ ...record, sourceKey: 'original:1' })
            const text =
              '<workflow-output>\n<port name="summary">report.md</port>\n</workflow-output>'
            await sink.record({ raw: text, event: { kind: 'text', text, rawLine: text } })
            await sink.checkpoint('records')
            await request.cleanup?.()
            return {
              result: 'ok',
              exitCode: 0,
              stderrTail: '',
              durationMs: 1,
              unreapedMessage: () => 'unexpected',
              reportUnreaped: () => undefined,
              settle: async () => {
                settled = true
              },
            }
          },
        }
        const material = createTaskAgentMaterialPreparation({
          preparation: {
            workspace,
            compile: async () => ({
              materialRef: 'material',
              declared,
              evidenceCapabilities: {
                usageMeter: false,
                sessionCapture: false,
                inventory: false,
                finalEvents: false,
                liveCapture: false,
                sessionSinkCapture: false,
              },
              bind: () => binding,
            }),
          },
          resources: {
            injection: { skills: [], plugins: [] },
            prepareMounts: () => [workspace.workspace],
          },
          diagnostics: {
            readDeclaredMcpServers: () => declared.mcpServers,
            reportSpawn: () => undefined,
            detectPluginLoadFailure: () => null,
          },
        })
        const purpose: TaskAgentRunPurpose = {
          workspace,
          outputWorkspaceRef: workspace.workspace.reference,
          nodeRunPrompts: {
            store: async (_task, _run, prompt) => ({ promptText: prompt, promptPath: null }),
            read: async () => null,
          },
          portArtifacts: {
            archive: async () => ({
              archiveJson: '{"v":1,"items":[]}',
              portFilePaths: ['report.md'],
            }),
            read: async () => ({ items: [] }),
          },
          outputValidation: {
            resolve: async () => ({ body: '# report', sourcePath: 'report.md' }),
          },
          gitControlObservation: {
            capture: async () => {
              throw new Error('unexpected git read')
            },
          },
          selectMaterial: () => material,
          bindExecutionParticipants: () => ({
            taskEffect: Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>,
          }),
        }
        const result = await runSelectedTaskAgent(
          {
            taskId,
            nodeRunId,
            nodeId: 'n1',
            agent,
            inputs: {},
            templateMeta: { taskId, repoPath: 'repo:declared', baseBranch: 'main' },
            runtime,
            persistence: createTaskExecutionPersistence(db),
            observationInvocations: composeRunObservationCalls(db),
            memoryInjectionQueries: sqliteMemoryInjectionQueries(db),
            runtimeRegistry: composeRuntimeRegistryOperations(db),
            runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
            log: createLogger('hosted-inventory-test'),
          },
          purpose,
        )
        expect(result.status).toBe('done')
        expect(settled).toBe(true)
        const [final] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
        const inventory = JSON.parse(final!.runtimeInventoryJson!),
          verification = JSON.parse(final!.startupVerificationJson!)
        expect(inventory.state).toBe(state === 'verified' ? 'captured' : state)
        expect(eager).toMatchObject({ state: inventory.state })
        expect(verification.observation).toMatchObject({ state })
        if (state === 'verified') {
          expect(verification.observation.source).toBe(
            report.state === 'verified' ? report.source : undefined,
          )
          expect(verification.verification).toMatchObject({
            mcpUnusable: [{ name: 'missing', status: 'missing' }],
            skillsMissing: ['declared-skill'],
          })
          expect(inventory.faces).not.toHaveProperty('tools')
        } else expect(verification.observation.reason).toBe('inventory-test-failure')
        const events = await db
          .select()
          .from(nodeRunEvents)
          .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
        expect(events.some((row) => row.payload.includes('startup-inventory'))).toBe(false)
      })
})
