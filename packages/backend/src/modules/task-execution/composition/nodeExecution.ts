import type { WorkflowNode } from '@agent-workflow/shared'
import type { LegacyTaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { createClarifyRound } from '@/services/clarify/service'
import { runWrapperFanoutNode, runWrapperGitNode, runWrapperLoopNode } from '@/services/scheduler'
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
import type { WorkgroupEngineHooks } from '@/services/workgroup/hooks'
import type { CollaborationNodeGatePort } from '../application/ports/collaborationNodeGate'
import type { WrapperNodeExecutionPort } from '../application/ports/wrapperNodeExecution'
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

const gateways = new WeakMap<LegacyTaskMechanicsState, NodeExecutionGateway>()

function legacyArgs(state: LegacyTaskMechanicsState, request: NodeStepRequest): OneNodeArgs {
  return { node: request.node as WorkflowNode, iteration: request.iteration, log: state.log }
}

function legacyHostPort(
  state: LegacyTaskMechanicsState,
  collaboration: CollaborationNodeGatePort,
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

function collaborationPort(state: LegacyTaskMechanicsState): CollaborationNodeGatePort {
  return {
    requestReview: (request) => runReviewNode(state, legacyArgs(state, request)),
    inspectCrossClarify: (request) => runCrossClarifyNode(state, legacyArgs(state, request)),
    async openAgentClarify(request) {
      const common = {
        db: state.db,
        taskId: request.taskId,
        askingNodeId: request.askingNodeId,
        askingNodeRunId: request.askingNodeRunId,
        intermediaryNodeId: request.intermediaryNodeId,
        questions: [...request.questions],
        ...(request.truncationWarnings === undefined
          ? {}
          : { truncationWarnings: [...request.truncationWarnings] }),
      }
      const result =
        request.kind === 'self'
          ? await createClarifyRound({
              ...common,
              kind: 'self',
              askingShardKey: request.askingShardKey,
              iteration: request.iteration,
              ...(request.parentNodeRunId === undefined
                ? {}
                : { parentNodeRunId: request.parentNodeRunId }),
            })
          : await createClarifyRound({
              ...common,
              kind: 'cross',
              targetConsumerNodeId: request.targetConsumerNodeId,
              loopIter: request.loopIter,
            })
      return { intermediaryNodeRunId: result.intermediaryNodeRunId }
    },
  }
}

function buildGateway(state: LegacyTaskMechanicsState): NodeExecutionGateway {
  const collaboration = collaborationPort(state)
  const wrapperPort: WrapperNodeExecutionPort = {
    execute(kind, request) {
      const args = legacyArgs(state, request)
      if (kind === 'wrapper-git') return runWrapperGitNode(state, args)
      if (kind === 'wrapper-loop') return runWrapperLoopNode(state, args)
      return runWrapperFanoutNode(state, args)
    },
  }
  const wrappers = createWrapperDelegatingNodeExecutors(wrapperPort)
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
        executeAgent: (request) =>
          runAgentSingleNode(state, legacyArgs(state, request), collaboration),
      },
      legacyHostPort(state, collaboration),
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
      const outcome = await judgeBranchActivation(state, request.node, request.iteration)
      return outcome === null ? { kind: 'active' } : { kind: 'inactive', outcome }
    },
  })
}

function gatewayFor(state: LegacyTaskMechanicsState): NodeExecutionGateway {
  const existing = gateways.get(state)
  if (existing !== undefined) return existing
  const created = buildGateway(state)
  gateways.set(state, created)
  return created
}

/** The sole production entry for one ready DAG node. */
export function executeNode(
  state: LegacyTaskMechanicsState,
  args: OneNodeArgs,
): ReturnType<NodeExecutionGateway['executeNode']> {
  return gatewayFor(state).executeNode({
    node: args.node,
    task: { taskId: state.taskId },
    scope: { scopeId: state.containerOf.get(args.node.id) ?? null },
    iteration: args.iteration,
    execution: { ...(state.opts.signal === undefined ? {} : { signal: state.opts.signal }) },
  })
}

/** Shared typed host lane used by the workgroup adapter during T10 cutover. */
export function executeWorkgroupHost(
  state: LegacyTaskMechanicsState,
  request: WorkgroupHostExecutionRequest,
) {
  return gatewayFor(state).executeHost(request)
}

/** Workgroup engines keep their hook shape while the host body resolves through the registry. */
export function buildNodeExecutionWorkgroupHooks(
  state: LegacyTaskMechanicsState,
): WorkgroupEngineHooks {
  return {
    ...buildWorkgroupEngineSupport(state),
    runHostNode: (host) =>
      executeWorkgroupHost(state, {
        lane: 'workgroup-host',
        task: { taskId: state.taskId },
        host,
        execution: {
          ...(state.opts.signal === undefined ? {} : { signal: state.opts.signal }),
        },
      }),
  }
}
