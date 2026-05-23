// RFC-061 PR-B — NodeKindHandler registry.
//
// One entry per RFC-060 NodeKind. The `satisfies Record<NodeKind, ...>`
// clause is the compile-time exhaustiveness check that replaces today's
// "5 dispatchers each pick the current row with a different selector"
// pattern: adding a new NodeKind to the closed union without registering
// a handler here fails `tsc`.
//
// This registry is consumed by the taskActor (RFC-061 PR-B T9). The
// shared `NODE_KIND_HANDLERS` placeholder in `@agent-workflow/shared/handlers`
// remains `Partial<>` since the shared layer cannot reference backend
// handlers — the real exhaustiveness check lives here.

import type { NodeKind, NodeKindHandler } from '@agent-workflow/shared'

import { agentSingleNodeKindHandler } from './agentSingle'
import { clarifyNodeKindHandler } from './clarify'
import { clarifyCrossAgentNodeKindHandler } from './clarifyCrossAgent'
import { inputNodeKindHandler } from './input'
import { outputNodeKindHandler } from './output'
import { reviewNodeKindHandler } from './review'
import { wrapperFanoutNodeKindHandler } from './wrapperFanout'
import { wrapperGitNodeKindHandler } from './wrapperGit'
import { wrapperLoopNodeKindHandler } from './wrapperLoop'

/**
 * Full Record over the closed NodeKind union — TS will refuse to compile
 * if any kind is missing. This is the structural guarantee called out in
 * RFC-061 design.md §5.
 */
export const NODE_KIND_HANDLERS = {
  'agent-single': agentSingleNodeKindHandler,
  input: inputNodeKindHandler,
  output: outputNodeKindHandler,
  'wrapper-git': wrapperGitNodeKindHandler,
  'wrapper-loop': wrapperLoopNodeKindHandler,
  'wrapper-fanout': wrapperFanoutNodeKindHandler,
  review: reviewNodeKindHandler,
  clarify: clarifyNodeKindHandler,
  'clarify-cross-agent': clarifyCrossAgentNodeKindHandler,
} satisfies { [K in NodeKind]: NodeKindHandler<K> }

export type RegisteredNodeKindHandlers = typeof NODE_KIND_HANDLERS

export {
  agentSingleNodeKindHandler,
  clarifyNodeKindHandler,
  clarifyCrossAgentNodeKindHandler,
  inputNodeKindHandler,
  outputNodeKindHandler,
  reviewNodeKindHandler,
  wrapperFanoutNodeKindHandler,
  wrapperGitNodeKindHandler,
  wrapperLoopNodeKindHandler,
}

// Re-export per-kind dispatch context types so callers (taskActor, REST
// routes) can assemble them without digging into handler subdirectories.
export type {
  AgentSingleDispatchContext,
  AgentSingleDispatchExtras,
  UpstreamInput,
} from './agentSingle'
export type {
  ClarifyCrossAgentDispatchContext,
  ClarifyCrossAgentDispatchExtras,
} from './clarifyCrossAgent'
export type { InputDispatchContext, InputDispatchExtras } from './input'
export type { OutputDispatchContext, OutputDispatchExtras, OutputBinding } from './output'
export type { ReviewDispatchContext, ReviewDispatchExtras } from './review'
export type {
  WrapperGitDispatchContext,
  WrapperGitDispatchExtras,
  WrapperGitInnerCompletedContext,
  WrapperGitInnerCompletedExtras,
} from './wrapperGit'
export type {
  WrapperLoopDispatchContext,
  WrapperLoopDispatchExtras,
  WrapperLoopInnerCompletedContext,
  WrapperLoopInnerCompletedExtras,
  ExitConditionShape,
} from './wrapperLoop'
export type {
  WrapperFanoutDispatchContext,
  WrapperFanoutDispatchExtras,
  WrapperFanoutInnerCompletedContext,
  WrapperFanoutInnerCompletedExtras,
  WrapperFanoutReadyContext,
  WrapperFanoutReadyExtras,
} from './wrapperFanout'
export { parseExitCondition, parseMaxIterations } from './wrapperLoop'
export { composePrompt } from './agentSingle'
export { readBindings } from './output'
