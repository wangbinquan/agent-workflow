// RFC-412 — the ports of the automatic commit&push tail (engine/node/commit-push/runCommitPush.ts). Only
// task-execution, shared and public types: the commit attempt (infrastructure/commitPushAttempt.ts, which publishes
// through Source Control's public workspace change publication — RFC-475) and the built-in commit agent
// (domain/commitAgent.ts) arrive through the composition binding.
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

/** The commit-message / repair generator contexts the commit attempt hands back (Source Control's shapes plus the row id). */
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
  /** null → the deterministic fallback message stays. */
  message: string | null
  /** Runtime session id to stamp on the commit row, when the generator spawned one. */
  sessionId?: string | null
  /** The generator child may still be alive; no git mutation or replacement is safe. */
  processUnreaped?: true
}

/** One repository's commit&push request, as the engine assembles it. */
export interface AutoCommitPushRequest {
  taskId: string
  /** The workflow node whose completion triggered this commit. */
  agentNodeId: string
  /** Human-readable agent name for the fallback commit message. */
  agentName: string
  /** node_run id of the triggering agent (becomes parentNodeRunId). */
  parentNodeRunId: string | null
  worktreePath: string
  /** Stable source-repository identity for cross-worktree publication fencing. */
  repositoryIdentity?: string
  /** Local branch to commit on + push (working branch or isolation branch). */
  repoBranch: string
  /** Base ref the worktree was branched from (for prompt context). */
  baseRef: string
  /** Multi-repo disambiguator for the synthetic node id; omit for single-repo. */
  repoSlug?: string
  /** Persisted work owner; null/system tasks deliberately skip the personal layer. */
  ownerUserId?: string | null
  gitUserName: string | null
  gitUserEmail: string | null
  maxRepairRetries: number
  diffMaxBytes: number
  /** RFC-308: one immutable config slice for this whole publication attempt. */
  excludePatterns?: readonly string[]
  generateMessage: (ctx: CommitMessageContext) => Promise<GeneratedCommitMessage>
  generateRepair: (ctx: CommitRepairContext) => Promise<GeneratedCommitMessage>
  /**
   * RFC-076 C4 — optional write-lock acquirer (the scheduler passes its
   * per-task `writeSem.acquire`). Acquired once around `git add -A` + the
   * `git diff --cached` capture and again around the eventual local `git commit`.
   * The first section freezes a consistent index snapshot; the second prevents
   * a sibling writer's Git lifecycle from contending for `.git/index.lock` while
   * that snapshot becomes a commit. The lock remains RELEASED during slow LLM
   * message generation and network push, so independent node work is not held
   * behind either. Omit → no lock (single-writer / test callers take the same
   * unlocked path).
   */
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
