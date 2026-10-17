import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { isTerminalSubtaskState } from '@/platform/crewstation/businessExecution'
import { createLogger } from '@/util/log'
import { runSystemAgentCore } from '../application/systemAgentRun'
import type { SystemAgentRunPolicy } from '../application/ports/systemAgentRun'
import type { SystemAgentObservationRun } from '../application/ports/systemAgentObservation'
import { createHostedAgentInvocationPreparation } from './crewstationAgentInvocation'
import { sha256Hex } from '@/util/hash'

type Turn = { readonly sessionId: string; readonly id: string }

/** MCP diagnostics use the ordinary Agent execution core. Each diagnostic
 * session owns a persistent parent; every turn keeps its stable invocation ID. */
export function createCrewStationMcpDiagnosticRunner(
  input: Pick<
    Parameters<typeof createHostedAgentInvocationPreparation>[0],
    | 'db'
    | 'fence'
    | 'api'
    | 'executions'
    | 'profiles'
    | 'startupInventoryAvailable'
    | 'nativeConfigAvailable'
    | 'nativeModelMappingAvailable'
    | 'pluginFiles'
    | 'materialEnvironment'
  > & {
    readonly helper: WorkspaceHelper
    readonly reference: (taskId: string, path: string) => string
    readonly workspaces: {
      ensure(taskId: string): Promise<{ readonly businessTaskId: string }>
      /** Makes an allocated parent ready (resumes a paused one); never allocates. */
      open(taskId: string): Promise<{ readonly businessTaskId: string } | null>
      close(taskId: string): Promise<boolean>
    }
  },
) {
  const taskId = (sessionId: string) => `mcp-test:${sessionId}`
  const executionId = (turn: Turn) => `agent:${taskId(turn.sessionId)}:mcp:${turn.id}`
  const directory = (sessionId: string) => `/work/system/shared/${sha256Hex(sessionId)}`
  const workspaceReference = (sessionId: string) =>
    input.reference(taskId(sessionId), directory(sessionId))
  const find = (turn: Turn) => input.executions.find(executionId(turn))
  return {
    workspaceReference,
    async workspaceExists(sessionId: string) {
      // A paused parent's files are readable only once it runs again (§9.2 V3).
      const parent = await input.workspaces.open(taskId(sessionId))
      if (parent === null) return false
      try {
        await input.api.listFiles(parent.businessTaskId, {
          path: `${directory(sessionId)}/worktree`,
          limit: 1,
        })
        return true
      } catch {
        return false
      }
    },
    async cleanup(sessionId: string) {
      if (!(await input.executions.workspaceSettled(taskId(sessionId), '/work'))) return false
      return input.workspaces.close(taskId(sessionId))
    },
    async hasExecution(turn: Turn) {
      return (await find(turn)) !== null
    },
    /** Recovery never repeats a missing submission or cancels a live process.
     * The exact platform attempt and its terminal result must still agree. */
    async settled(turn: Turn) {
      const binding = await find(turn)
      if (binding === null) return true
      if (
        binding.cancelReason === 'restored' ||
        binding.subtaskId === null ||
        binding.attempt === null
      )
        return false
      const current = await input.api.getSubtask(binding.businessTaskId, binding.subtaskId)
      if (
        current.id !== binding.subtaskId ||
        current.taskId !== binding.businessTaskId ||
        current.attempt !== binding.attempt ||
        !isTerminalSubtaskState(current.state) ||
        current.result === undefined
      )
        return false
      if (binding.state !== 'settled') {
        const outcome = await input.executions.adopt(binding.executionId, {
          started: async () => undefined,
          event: async () => undefined,
          checkpoint: async () => undefined,
        })
        await outcome.settle()
      }
      return true
    },
    async run(request: {
      readonly sessionId: string
      readonly turnId: string
      readonly intent: Omit<AgentMaterialIntent, 'workspace' | 'runContent' | 'nodeRunId' | 'log'>
      readonly policy: SystemAgentRunPolicy
      readonly timeoutMs: number
      readonly maxEventTextBytes: number
      readonly beforeStart: () => Promise<void>
      readonly acknowledgeStarted: () => Promise<void>
      readonly observe?: (startedAt: number) => Promise<SystemAgentObservationRun>
    }) {
      const owner = taskId(request.sessionId)
      const root = directory(request.sessionId)
      const log = createLogger('hosted-mcp-runtime-test')
      const workspace: AgentMaterialWorkspace = {
        workspace: {
          owner: 'source-control',
          reference: input.reference(owner, `${root}/worktree`),
          version: null,
        },
        runContent: {
          owner: 'runtime-management',
          reference: input.reference(owner, `${root}/run/turns/${request.turnId}`),
          version: null,
        },
        retainedRef: workspaceReference(request.sessionId),
        async prepare() {
          await request.beforeStart()
          await input.helper.call(
            owner,
            'system-workspace',
            {
              method: 'prepare',
              namespace: 'shared',
              key: root.split('/').at(-1),
              seeds: [],
            },
            { operationId: `mcp:${request.turnId}:prepare` },
          )
        },
        // Session cleanup owns this parent, including failed/unknown turns.
        discard: async () => undefined,
      }
      return runSystemAgentCore(
        { ...request.policy, retainScratchOnSuccess: true },
        {
          log,
          timeoutMs: request.timeoutMs,
          maxEventTextBytes: request.maxEventTextBytes,
          startedAt: Date.now(),
          retainedRef: workspace.retainedRef,
          invocation: {
            workspace,
            acknowledgeStart: () => true,
            prepareWorkspace: () => workspace.prepare(),
            ...(request.observe ? { observe: request.observe } : {}),
            async compile() {
              const parent = await input.workspaces.ensure(owner)
              return createHostedAgentInvocationPreparation({
                ...input,
                taskId: owner,
                businessTaskId: parent.businessTaskId,
                workspace,
                cwd: `${root}/worktree`,
                beforeStart: request.beforeStart,
                acknowledgeStarted: request.acknowledgeStarted,
                skillFiles: async () => {
                  throw new Error('mcp-test-unexpected-skill-material')
                },
              }).compile({
                ...request.intent,
                workspace: workspace.workspace,
                runContent: workspace.runContent,
                nodeRunId: `mcp:${request.turnId}`,
                log,
              })
            },
          },
        },
      )
    },
  }
}
