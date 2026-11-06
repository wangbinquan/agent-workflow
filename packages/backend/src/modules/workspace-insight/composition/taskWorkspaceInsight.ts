// RFC-453 — assembles the workspace-insight surface the tasks route reaches. The structural diff, symbols, code
// intel and narrative read through one set of code-review reads (the task workspace, the selected revision content
// and artifact store, this module's deep indexing); file content reads the task worktrees and call targets the
// call-graph read model. Every dependency is a required parameter (RFC-359 W1-T1), so this file only binds.

import type {
  TaskCallGraphWorkspaceReadModel,
  TaskCodeWorkspaceQueries,
} from '@/modules/task-execution/public/types'
import type { TaskWorktreeLocator } from '@/modules/task-execution/public/queries'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import { getCallTargets } from '../application/callGraph/callTargets'
import {
  getChangeNarrativeStatus,
  triggerChangeNarrative,
  type ChangeNarrativeDeps,
} from '../application/changeNarrative'
import { getCodeIntel } from '../application/codeIntel/codeIntel'
import { getTaskFileSymbols } from '../application/codeIntel/fileSymbols'
import { getTaskFileContent } from '../application/fileContent'
import type { CodeReviewArtifactStore } from '../application/ports/codeReviewArtifacts'
import type { TaskWorkspaceInsight } from '../application/ports/taskWorkspaceInsight'
import {
  getTaskStructuralDiff,
  type CodeReviewReads,
} from '../application/structuralDiff/taskStructuralDiff'
import { composeStructuralDeepIndexing } from './structuralDeepIndexing'

export function composeTaskWorkspaceInsight(input: {
  readonly workspace: TaskCodeWorkspaceQueries
  readonly content: RepositoryRevisionContentFactory
  readonly artifacts: CodeReviewArtifactStore
  readonly worktrees: TaskWorktreeLocator
  readonly callGraphWorkspace: TaskCallGraphWorkspaceReadModel
  readonly narrative: Pick<ChangeNarrativeDeps, 'resolveRuntime' | 'systemAgents'>
}): TaskWorkspaceInsight {
  const reads: CodeReviewReads = {
    workspace: input.workspace,
    content: input.content,
    artifacts: input.artifacts,
    deep: composeStructuralDeepIndexing(),
  }
  const insight: TaskWorkspaceInsight = {
    structuralDiff: (taskId, scope, nodeRunId, options) =>
      getTaskStructuralDiff(reads, taskId, scope, nodeRunId, options),
    changeNarrativeStatus: (taskId) => getChangeNarrativeStatus(taskId, input.artifacts),
    triggerChangeNarrative: (task, runtime) =>
      triggerChangeNarrative(
        {
          workspace: reads,
          resolveRuntime: input.narrative.resolveRuntime,
          systemAgents: input.narrative.systemAgents,
          runtimeName: runtime.runtimeName,
          defaultRuntime: runtime.defaultRuntime,
        },
        task,
      ),
    fileContent: (taskId, query) =>
      getTaskFileContent(input.worktrees, taskId, query, { content: input.content }),
    fileSymbols: (taskId, query) => getTaskFileSymbols(reads, taskId, query),
    codeIntel: (taskId, query) => getCodeIntel(reads, taskId, query),
    callTargets: (taskId, methodRef) =>
      getCallTargets(input.callGraphWorkspace, taskId, methodRef, input.content),
  }
  return Object.freeze(insight)
}
