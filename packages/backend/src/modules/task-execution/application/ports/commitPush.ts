// RFC-412 — the ports of the automatic commit&push tail (engine/node/commit-push/runCommitPush.ts). Only
// task-execution, shared and public types: the source-control commit runner and commit-agent helpers arrive
// through the composition binding.
import type { Language } from '@agent-workflow/shared'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { AgentRunLaunch, AgentRunRequest } from './agentNodeExecution'
import type { Logger } from './executionKernel'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { SchedulerCompletionPersistence } from './schedulerCompletionPersistence'
import type { RunResult } from './taskAgentRun'
import type { TaskAgentRunFamily } from './taskAgentRunFamily'
import type { TaskEngineTaskSnapshot } from './taskEngineApplicationPersistence'

/** The commit-message / repair generator contexts the commit runner hands back (source-control shapes). */
export interface CommitMessageContext {
  nodeRunId: string
  repoName: string
  branch: string
  baseRef: string
  stat: string
  diffTruncated: string
}
export interface CommitRepairContext {
  nodeRunId: string
  branch: string
  stat: string
  pushStderr: string
  currentMessage: string
  priorAttempts: number
}
export interface GeneratedCommitMessage {
  message: string | null
  sessionId?: string | null
  processUnreaped?: true
}

/** One repository's commit&push request, as the engine assembles it. */
export interface AutoCommitPushRequest {
  taskId: string
  agentNodeId: string
  agentName: string
  parentNodeRunId: string | null
  worktreePath: string
  repositoryIdentity?: string
  repoBranch: string
  baseRef: string
  repoSlug?: string
  ownerUserId?: string | null
  gitUserName: string | null
  gitUserEmail: string | null
  maxRepairRetries: number
  diffMaxBytes: number
  excludePatterns?: readonly string[]
  generateMessage: (ctx: CommitMessageContext) => Promise<GeneratedCommitMessage>
  generateRepair: (ctx: CommitRepairContext) => Promise<GeneratedCommitMessage>
  acquireWrite?: () => Promise<() => void>
}

export interface AutoCommitPushPorts {
  readonly task: TaskEngineTaskSnapshot
  /** The task's repository mounts as the execution state holds them (template metadata takes the same list). */
  readonly repos: TaskRepositoryMount[]
  readonly repoGroupName: string | null
  readonly signal: AbortSignal | undefined
  readonly history: Pick<SchedulerCompletionPersistence, 'listDoneNodeRuns'>
  readonly nodeRuns: Pick<NodeRunLifecyclePersistence, 'mint' | 'loadEnvelopeNonce'>
  readonly runtime: {
    internal: TaskAgentRunFamily['runtimeBindings']['internal']
    resolve: TaskAgentRunFamily['runtimeBindings']['resolve']
    /** The commit agent's session run; the binding adds the task-level run fields the original passed. */
    runAgent(request: AgentRunRequest, launch: AgentRunLaunch): Promise<RunResult>
  }
  readonly commitAgent: {
    nodeId(nodeId: string, repoSlug: string | undefined): string
    readonly messagePort: string
    /** The code-owned commit agent and its resolved synthetic injection (resolution failures surface as `failed`). */
    prepare(): {
      agent: AgentRunRequest['agent']
      injection:
        | { kind: 'failed'; message: string }
        | {
            kind: 'ok'
            spec: {
              dependents: AgentRunRequest['dependents']
              mcps: AgentRunRequest['mcps']
              material: AgentRunLaunch['material']
            }
          }
    }
    messagePrompt(
      input: {
        repoName: string
        branch: string
        baseRef: string
        stat: string
        diffTruncated: string
        lang: Language
      },
      envelopeNonce: string,
    ): string
    repairPrompt(
      input: {
        branch: string
        pushStderr: string
        currentMessage: string
        stat: string
        priorAttempts: number
        lang: Language
      },
      envelopeNonce: string,
    ): string
  }
  readonly repository: {
    /** `git status --porcelain` of one repository's task workspace. */
    statusPorcelain(repo: TaskRepositoryMount): Promise<{ stdout: string }>
  }
  readonly effects: {
    runCommitPush(
      request: AutoCommitPushRequest,
      deps: { log: Logger; publicationTransport: RepositoryPublicationTransport },
    ): Promise<{ processUnreaped?: true }>
    acquireWrite(): Promise<() => void>
  }
  readonly config: {
    readonly commitPushRuntime: string | undefined
    readonly commitPushModel: string | undefined
    readonly defaultRuntime: string | undefined
    readonly commitPushMaxRepairRetries: number | undefined
    readonly commitPushDiffMaxBytes: number | undefined
    readonly commitPushLang: Language | undefined
    readonly repositoryPublicationTransport: RepositoryPublicationTransport | undefined
    excludePatterns(): Promise<readonly string[]>
  }
}
