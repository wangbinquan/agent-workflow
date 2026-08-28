// RFC-333 — composition-owned dependencies for exact collaboration commands.
// Public callers carry only an opaque object reference; the live DB and app
// home never become part of a public command/query contract.

import type { DbClient } from '@/db/client'
import type { CollaborationCommandContext } from '../public/types'
import type { ReviewDecisionCommandPort } from '../application/ports/reviewDecisionCommand'
import type { QuestionDispatchCommandPort } from '../application/ports/questionDispatchCommand'
import type { ClarifyDecisionCommandPort } from '../application/ports/clarifyDecisionCommand'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/queries'

export interface CollaborationCommandDependencies {
  readonly db: DbClient
  readonly appHome?: string
  readonly reviewDecisions?: ReviewDecisionCommandPort
  readonly questionDispatches?: QuestionDispatchCommandPort
  readonly clarifyDecisions?: ClarifyDecisionCommandPort
  readonly taskExecutionReadModels?: TaskExecutionReadModels
}

const dependencies = new WeakMap<object, CollaborationCommandDependencies>()

export function createCollaborationCommandContext(
  input: CollaborationCommandDependencies,
): CollaborationCommandContext {
  const context = Object.freeze({})
  dependencies.set(context, Object.freeze({ ...input }))
  return context as CollaborationCommandContext
}

export function resolveCollaborationCommandContext(
  context: CollaborationCommandContext,
): CollaborationCommandDependencies {
  const resolved = dependencies.get(context)
  if (resolved === undefined) throw new Error('collaboration command context is not composed')
  return resolved
}

export function requireCollaborationAppHome(context: CollaborationCommandContext): string {
  const appHome = resolveCollaborationCommandContext(context).appHome
  if (appHome === undefined || appHome.length === 0) {
    throw new Error('collaboration command context has no app home')
  }
  return appHome
}

export function requireReviewDecisionCommand(
  context: CollaborationCommandContext,
): ReviewDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).reviewDecisions
  if (command === undefined)
    throw new Error('collaboration review decision command is not composed')
  return command
}

export function requireQuestionDispatchCommand(
  context: CollaborationCommandContext,
): QuestionDispatchCommandPort {
  const command = resolveCollaborationCommandContext(context).questionDispatches
  if (command === undefined)
    throw new Error('collaboration question dispatch command is not composed')
  return command
}

export function requireClarifyDecisionCommand(
  context: CollaborationCommandContext,
): ClarifyDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).clarifyDecisions
  if (command === undefined)
    throw new Error('collaboration clarify decision command is not composed')
  return command
}

export function requireCollaborationTaskExecutionReadModels(
  context: CollaborationCommandContext,
): TaskExecutionReadModels {
  const readModels = resolveCollaborationCommandContext(context).taskExecutionReadModels
  if (readModels === undefined) {
    throw new Error('collaboration task-execution read models are not composed')
  }
  return readModels
}
