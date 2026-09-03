import type { WorkflowNode } from '@agent-workflow/shared'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type { WrapperRuntimeFactory } from './taskExecutionComponents'
import {
  buildWorkgroupEngineSupport,
  executeWorkgroupHostMechanics,
  judgeBranchActivation,
  runAgentSingleNode,
  runCallWorkflowNode,
  runCodeHostCallNode,
  runCrossClarifyNode,
  runInputNode,
  runOutputNode,
  runReviewNode,
  runScriptNode,
  type OneNodeArgs,
} from './nodeMechanics'
import type { WorkgroupTurnHostOperations } from '../application/ports/workgroupTurnsOperations'
import type { CollaborationNodeGatePort } from '../application/ports/collaborationNodeGate'
import type {
  WorkgroupHostExecutionPort,
  WorkgroupHostExecutionRequest,
} from '../application/ports/workgroupHostExecution'
import type { NodeStepRequest } from '../domain/nodeExecution'
import { AgentSingleNodeExecutor } from '../engine/node/agentNodeExecutor'
import {
  CallWorkflowNodeExecutor,
  CallWorkgroupNodeExecutor,
} from '../engine/node/childCallNodeExecutors'
import { CodeHostCallNodeExecutor } from '../engine/node/codeHostCallNodeExecutor'
import {
  ClarifyNodeExecutor,
  CrossClarifyNodeExecutor,
  ReviewNodeExecutor,
} from '../engine/node/humanGateNodeExecutors'
import { NodeExecutionGateway } from '../engine/node/nodeExecutionGateway'
import type { NodeExecutorMap } from '../engine/node/nodeExecutor'
import { ClosedNodeExecutorRegistry } from '../engine/node/nodeExecutorRegistry'
import { RetiredCodeRoundNodeExecutor } from '../engine/node/retiredCodeRoundNodeExecutor'
import { ScriptNodeExecutor } from '../engine/node/scriptNodeExecutor'
import { InputNodeExecutor, OutputNodeExecutor } from '../engine/node/virtualIoNodeExecutors'
import { createWrapperDelegatingNodeExecutors } from '../engine/node/wrapperDelegatingNodeExecutors'

const gateways = new WeakMap<TaskMechanicsState, NodeExecutionGateway>()

function legacyArgs(
  state: TaskMechanicsState,
  request: Pick<NodeStepRequest, 'node' | 'iteration' | 'containerRunId'>,
): OneNodeArgs {
  return {
    node: request.node as WorkflowNode,
    containerRunId: request.containerRunId,
    iteration: request.iteration,
    log: state.log,
  }
}

function legacyHostPort(
  state: TaskMechanicsState,
  collaboration: CollaborationRuntimeMechanics,
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

function collaborationPort(state: TaskMechanicsState): CollaborationNodeGatePort {
  const mechanics: CollaborationRuntimeMechanics = state.opts.collaborationRuntime
  return {
    requestReview: (request) => runReviewNode(state, legacyArgs(state, request), mechanics),
    inspectCrossClarify: (request) =>
      runCrossClarifyNode(state, legacyArgs(state, request), mechanics),
    async openAgentClarify(request) {
      const result = await mechanics.openAgentClarify({
        ...request,
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      return { intermediaryNodeRunId: result.intermediaryNodeRunId }
    },
  }
}

function buildGateway(
  state: TaskMechanicsState,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): NodeExecutionGateway {
  const mechanics = state.opts.collaborationRuntime
  const collaboration = collaborationPort(state)
  const wrapperRuntime = wrapperRuntimeFactory(state)
  const wrappers = createWrapperDelegatingNodeExecutors(wrapperRuntime, state.wrapperScopes)
  const virtualIo = {
    executeInput: (request: NodeStepRequest<'input'>) =>
      runInputNode(state, legacyArgs(state, request)),
    executeOutput: (request: NodeStepRequest<'output'>) =>
      runOutputNode(state, legacyArgs(state, request)),
  }
  const childCalls = {
    executeWorkflow: (request: NodeStepRequest<'call-workflow'>) =>
      runCallWorkflowNode(state, legacyArgs(state, request)),
    executeWorkgroup: (request: NodeStepRequest<'call-workgroup'>) =>
      runCallWorkflowNode(state, legacyArgs(state, request)),
  }
  const executors = {
    'agent-single': new AgentSingleNodeExecutor(
      {
        executeAgent: (request) => runAgentSingleNode(state, legacyArgs(state, request), mechanics),
      },
      legacyHostPort(state, mechanics),
    ),
    input: new InputNodeExecutor(virtualIo),
    output: new OutputNodeExecutor(virtualIo),
    ...wrappers,
    review: new ReviewNodeExecutor(collaboration),
    clarify: new ClarifyNodeExecutor(),
    'clarify-cross-agent': new CrossClarifyNodeExecutor(collaboration),
    'call-workflow': new CallWorkflowNodeExecutor(childCalls),
    'call-workgroup': new CallWorkgroupNodeExecutor(childCalls),
    script: new ScriptNodeExecutor({
      executeScript: (request) => runScriptNode(state, legacyArgs(state, request)),
    }),
    'code-host-call': new CodeHostCallNodeExecutor({
      executeCodeHostCall: (request) => runCodeHostCallNode(state, legacyArgs(state, request)),
    }),
    'code-round': new RetiredCodeRoundNodeExecutor(),
  } satisfies NodeExecutorMap

  return new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
    async judge(request) {
      const outcome = await judgeBranchActivation(
        state,
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
