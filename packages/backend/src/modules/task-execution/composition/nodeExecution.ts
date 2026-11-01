import { createAgentNodeExecutionPorts } from './agentNodeExecution'
import { createCodeHostNodeExecutionPorts } from './codeHostNodeExecution'
import { createChildCallNodeExecutionPorts } from './childCallNodeExecution'
import {
  createInputNodeExecutionPorts,
  createOutputNodeExecutionPorts,
} from './virtualIoNodeExecution'
import {
  createReviewNodeExecutionPorts,
  createClarifyNodeExecutionPorts,
  createCrossClarifyNodeExecutionPorts,
} from './humanGateNodeExecution'
import { createNodeBranchActivationPorts } from './nodeBranchActivation'
import { judgeBranchActivation } from '../application/nodeBranchActivation'
import { createScriptNodeExecutionPorts } from './scriptNodeExecution'
import type { WorkflowNode } from '@agent-workflow/shared'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { Logger } from '@/util/log'
import type { WrapperRuntimeFactory } from './taskExecutionComponents'
import { buildWorkgroupEngineSupport, executeWorkgroupHostMechanics } from './nodeMechanics'
import type { WorkgroupTurnHostOperations } from '../application/ports/workgroupTurnsOperations'
import type { CollaborationNodeGatePort } from '../application/ports/collaborationNodeGate'
import type {
  WorkgroupHostExecutionPort,
  WorkgroupHostExecutionRequest,
} from '../application/ports/workgroupHostExecution'
import { AgentSingleNodeExecutor } from '../engine/node/agent-single/agentSingleNodeExecutor'
import { CallWorkflowNodeExecutor } from '../engine/node/call-workflow/callWorkflowNodeExecutor'
import { CallWorkgroupNodeExecutor } from '../engine/node/call-workgroup/callWorkgroupNodeExecutor'
import { CodeHostCallNodeExecutor } from '../engine/node/code-host-call/codeHostCallNodeExecutor'
import { ClarifyNodeExecutor } from '../engine/node/clarify/clarifyNodeExecutor'
import { CrossClarifyNodeExecutor } from '../engine/node/clarify-cross-agent/crossClarifyNodeExecutor'
import { ReviewNodeExecutor } from '../engine/node/review/reviewNodeExecutor'
import { NodeExecutionGateway } from '../engine/node/nodeExecutionGateway'
import type { NodeExecutorMap } from '../engine/node/nodeExecutor'
import { ClosedNodeExecutorRegistry } from '../engine/node/nodeExecutorRegistry'
import { RetiredCodeRoundNodeExecutor } from '../engine/node/retiredCodeRoundNodeExecutor'
import { ScriptNodeExecutor } from '../engine/node/script/scriptNodeExecutor'
import { InputNodeExecutor } from '../engine/node/input/inputNodeExecutor'
import { OutputNodeExecutor } from '../engine/node/output/outputNodeExecutor'
import { createWrapperDelegatingNodeExecutors } from '../engine/node/wrapperDelegatingNodeExecutors'

const gateways = new WeakMap<TaskMechanicsState, NodeExecutionGateway>()

/**
 * The scope interpreter's dispatch arguments for one ready node (RFC-405: moved here from
 * nodeMechanics.ts with its last consumer, `executeNode`).
 */
export interface OneNodeArgs {
  node: WorkflowNode
  /** RFC-354 — the frame (wrapper generation row) the node is dispatched in; null at the top scope. */
  containerRunId: string | null
  iteration: number
  log: Logger
}

function legacyHostPort(
  state: TaskMechanicsState,
  collaboration: TaskMechanicsState['opts']['collaborationRuntime'],
): WorkgroupHostExecutionPort {
  return {
    async executeHost(request: WorkgroupHostExecutionRequest) {
      const { hostOutputPorts, ...host } = request.host
      return executeWorkgroupHostMechanics(
        state,
        {
          ...host,
          ...(hostOutputPorts === undefined ? {} : { hostOutputPorts: [...hostOutputPorts] }),
        },
        collaboration,
      )
    },
  }
}

function buildGateway(
  state: TaskMechanicsState,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): NodeExecutionGateway {
  const mechanics = state.opts.collaborationRuntime satisfies CollaborationNodeGatePort
  const wrapperRuntime = wrapperRuntimeFactory(state)
  const wrappers = createWrapperDelegatingNodeExecutors(wrapperRuntime, state.wrapperScopes)
  const executors = {
    'agent-single': new AgentSingleNodeExecutor(
      createAgentNodeExecutionPorts(state),
      legacyHostPort(state, mechanics),
    ),
    input: new InputNodeExecutor(createInputNodeExecutionPorts(state)),
    output: new OutputNodeExecutor(createOutputNodeExecutionPorts(state)),
    ...wrappers,
    review: new ReviewNodeExecutor(createReviewNodeExecutionPorts(state)),
    clarify: new ClarifyNodeExecutor(createClarifyNodeExecutionPorts(state)),
    'clarify-cross-agent': new CrossClarifyNodeExecutor(
      createCrossClarifyNodeExecutionPorts(state),
    ),
    'call-workflow': new CallWorkflowNodeExecutor(createChildCallNodeExecutionPorts(state)),
    'call-workgroup': new CallWorkgroupNodeExecutor(createChildCallNodeExecutionPorts(state)),
    script: new ScriptNodeExecutor(createScriptNodeExecutionPorts(state)),
    'code-host-call': new CodeHostCallNodeExecutor(createCodeHostNodeExecutionPorts(state)),
    'code-round': new RetiredCodeRoundNodeExecutor(),
  } satisfies NodeExecutorMap

  const branch = createNodeBranchActivationPorts(state)
  return new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
    async judge(request) {
      const outcome = await judgeBranchActivation(
        branch,
        request.node,
        request.iteration,
        request.containerRunId,
      )
      return outcome === null ? { kind: 'active' } : { kind: 'inactive', outcome }
    },
  })
}

function gatewayFor(
  state: TaskMechanicsState,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): NodeExecutionGateway {
  const existing = gateways.get(state)
  if (existing !== undefined) return existing
  const created = buildGateway(state, wrapperRuntimeFactory)
  gateways.set(state, created)
  return created
}

/** The sole production entry for one ready DAG node. */
export function executeNode(
  state: TaskMechanicsState,
  args: OneNodeArgs,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): ReturnType<NodeExecutionGateway['executeNode']> {
  return gatewayFor(state, wrapperRuntimeFactory).executeNode({
    node: args.node,
    task: { taskId: state.taskId },
    scope: { scopeId: state.containerOf.get(args.node.id) ?? null },
    containerRunId: args.containerRunId,
    iteration: args.iteration,
    execution: { ...(state.opts.signal === undefined ? {} : { signal: state.opts.signal }) },
  })
}

/** Shared typed host lane used by the workgroup adapter during T10 cutover. */
export function executeWorkgroupHost(
  state: TaskMechanicsState,
  request: WorkgroupHostExecutionRequest,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
) {
  return gatewayFor(state, wrapperRuntimeFactory).executeHost(request)
}

/** Workgroup engines keep their hook shape while the host body resolves through the registry. */
export function buildNodeExecutionWorkgroupHooks(
  state: TaskMechanicsState,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): WorkgroupTurnHostOperations {
  return {
    ...buildWorkgroupEngineSupport(state),
    runHost: (host) =>
      executeWorkgroupHost(
        state,
        {
          lane: 'workgroup-host',
          task: { taskId: state.taskId },
          host,
          execution: {
            ...(state.opts.signal === undefined ? {} : { signal: state.opts.signal }),
          },
        },
        wrapperRuntimeFactory,
      ),
  }
}
