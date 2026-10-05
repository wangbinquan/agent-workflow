export interface AgentWorkspaceGitControlSnapshot {
  readonly head: string
  readonly symbolicHead: string
  readonly index: string
  readonly refs: string
  readonly localConfig: string
  readonly worktreeConfig: string
}

/** Bound semantic observations for the original Task Agent child window. */
export interface AgentWorkspaceGitControlObservation {
  capture(): Promise<AgentWorkspaceGitControlSnapshot>
}
