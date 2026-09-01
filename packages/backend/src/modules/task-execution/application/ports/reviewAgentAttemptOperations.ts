import type { Agent } from '@agent-workflow/shared'

export interface ReviewAgentSkill {
  readonly name: string
  readonly sourceKind: 'managed' | 'project'
  readonly sourcePath?: string
  readonly skillId?: string
  readonly contentVersion?: number
  readonly readContentVersion?: () => Promise<number>
}

export interface ReviewAgentAttemptInput {
  readonly taskId: string
  readonly nodeId: string
  readonly retryIndex: number
  readonly agent: Agent
  readonly prompt: string
  readonly worktreePath: string
  readonly repoPath: string
  readonly baseBranch: string
  readonly skills: readonly ReviewAgentSkill[]
  readonly appHome: string
  readonly defaultRuntime: string | null
  readonly timeoutMs?: number
}

/** Provider-selected execution seam for one review determinism attempt. */
export interface ReviewAgentAttemptOperations {
  run(input: ReviewAgentAttemptInput): Promise<{
    readonly outputs: Readonly<Record<string, string>>
    readonly sessionId: string | null
  }>
}
