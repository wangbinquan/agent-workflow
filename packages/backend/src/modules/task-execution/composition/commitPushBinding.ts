// RFC-412 — the composition bindings of the automatic commit&push tail and the read-only member inspection
// (engine/node/commit-push/runCommitPush.ts, engine/task/readonlyInspection.ts). Every value is read from the
// execution state when the engine asks for it; the source-control commit runner and commit-agent helpers and the
// synthetic agent injection resolver enter task-execution only here.
import {
  bindRepositoryGitWorkspace,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import {
  buildCommitAgent,
  buildCommitMessagePrompt,
  buildRepairPrompt,
  COMMIT_MESSAGE_PORT,
  commitPushNodeId,
} from '@/services/commitPush'
import { runCommitPush } from '@/services/commitPushRunner'
import { resolveSyntheticTaskAgentInjection } from '@/services/execution/taskExecutionResources'
import { readTaskCommitExcludePatterns } from '../application/operationConfiguration'
import type { AutoCommitPushPorts } from '../application/ports/commitPush'
import type { ReadonlyInspectionPorts } from '../application/ports/readonlyInspection'
import type { TaskRepositoryMount } from '../domain/taskRepository'
import { createFileTaskOperationConfiguration } from '../infrastructure/local/fileTaskOperationConfiguration'
import { runTaskAgentWithFamily } from './taskAgentRunFamily'
import type { TaskMechanicsState } from './taskMechanicsState'

/** RFC-308: one immutable settings slice per commit/freeze operation. */
export function readCommitExcludePatterns(
  opts: Pick<
    TaskMechanicsState['opts'],
    'operationConfiguration' | 'configPath' | 'commitPushExcludePatterns'
  >,
): Promise<readonly string[]> {
  return readTaskCommitExcludePatterns(
    opts.operationConfiguration ??
      (opts.configPath === undefined || opts.configPath === ''
        ? undefined
        : createFileTaskOperationConfiguration(opts.configPath)),
    opts.commitPushExcludePatterns ?? [],
  )
}

/** One repository workspace factory per commit&push / inspection pass, as the scheduler selected it. */
function repositoryStatus(state: TaskMechanicsState) {
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(
    state.opts.repositoryGitWorkspaces,
  )
  return {
    repositoryGitWorkspaces,
    statusPorcelain: (repo: TaskRepositoryMount) =>
      bindRepositoryGitWorkspace(repositoryGitWorkspaces, {
        taskId: state.task.id,
        workspaceRef: repo.worktreePath,
        repositoryRef: repo.repoPath,
      }).run(['status', '--porcelain']),
  }
}

export function createAutoCommitPushPorts(state: TaskMechanicsState): AutoCommitPushPorts {
  const { repositoryGitWorkspaces, statusPorcelain } = repositoryStatus(state)
  return {
    get task() {
      return state.task
    },
    get repos() {
      return state.repos
    },
    get repoGroupName() {
      return state.repoGroupName
    },
    get signal() {
      return state.opts.signal
    },
    history: {
      listDoneNodeRuns: (input) => state.opts.persistence.scheduler.listDoneNodeRuns(input),
    },
    get nodeRuns() {
      return state.opts.persistence.nodeRuns
    },
    runtime: {
      internal: (input) => state.opts.taskAgentRuns.runtimeBindings.internal(input),
      resolve: (...args) => state.opts.taskAgentRuns.runtimeBindings.resolve(...args),
      // The commit session carries exactly the task-level run fields the scheduler passed (no live subagent capture).
      runAgent: (request, launch) =>
        runTaskAgentWithFamily(
          state.opts.taskAgentRuns,
          {
            ...request,
            observationInvocations: state.opts.observationInvocations,
            memorySnapshots: state.opts.memorySnapshots,
            memoryInjectionQueries: state.opts.memoryInjectionQueries,
            runtimeSessionLeases: state.opts.runtimeSessionLeases,
            runtimeRegistry: state.opts.runtimeRegistry,
            persistence: state.opts.persistence,
            ...(state.opts.signal ? { signal: state.opts.signal } : {}),
          },
          launch,
        ),
    },
    commitAgent: {
      nodeId: (nodeId, repoSlug) => commitPushNodeId(nodeId, repoSlug),
      messagePort: COMMIT_MESSAGE_PORT,
      prepare: () => {
        const agent = buildCommitAgent()
        return {
          agent,
          injection: resolveSyntheticTaskAgentInjection(
            agent,
            state.opts.taskAgentRuns.materialReferences,
          ),
        }
      },
      messagePrompt: (input, envelopeNonce) => buildCommitMessagePrompt(input, envelopeNonce),
      repairPrompt: (input, envelopeNonce) => buildRepairPrompt(input, envelopeNonce),
    },
    repository: { statusPorcelain },
    effects: {
      runCommitPush: (request, deps) =>
        runCommitPush(request, {
          nodeRuns: state.opts.persistence.nodeRuns,
          nodeExecution: state.opts.persistence.nodeExecution,
          effects: state.opts.persistence.effects,
          log: deps.log,
          publicationTransport: deps.publicationTransport,
          repositoryGitWorkspaces,
        }),
      acquireWrite: () => state.writeSem.acquire(),
    },
    config: {
      get commitPushRuntime() {
        return state.opts.commitPushRuntime
      },
      get commitPushModel() {
        return state.opts.commitPushModel
      },
      get defaultRuntime() {
        return state.opts.defaultRuntime
      },
      get commitPushMaxRepairRetries() {
        return state.opts.commitPushMaxRepairRetries
      },
      get commitPushDiffMaxBytes() {
        return state.opts.commitPushDiffMaxBytes
      },
      get commitPushLang() {
        return state.opts.commitPushLang
      },
      get repositoryPublicationTransport() {
        return state.opts.repositoryPublicationTransport
      },
      excludePatterns: () => readCommitExcludePatterns(state.opts),
    },
  }
}

export function createReadonlyInspectionPorts(state: TaskMechanicsState): ReadonlyInspectionPorts {
  const { statusPorcelain } = repositoryStatus(state)
  return {
    get taskId() {
      return state.task.id
    },
    get repos() {
      return state.repos
    },
    get execution() {
      return state.opts.executionContext
    },
    statusPorcelain,
    recordReadonlyDirty: (input) => state.opts.persistence.scheduler.recordReadonlyDirty(input),
  }
}
