import type { ExecutionGroup } from '@agent-workflow/shared'
// RFC-370 v2 H7 — crash-only execution authority.
//
// One business path serves both deployments; only bootstrap picks the adapter.
// Standalone is always active. A CrewStation-hosted instance starts in standby,
// becomes active once the platform grants it the execution lease, and never
// returns to active after leaving it: the process exits and restarts as standby.

/** The fence a hosted instance writes under; stale fences are rejected. */
export interface ExecutionFence {
  readonly epoch: number
  readonly token: string
}

export type ExecutionAuthorityState =
  | { readonly kind: 'standby'; readonly reason: string | null }
  | { readonly kind: 'active'; readonly fence: ExecutionFence }
  | { readonly kind: 'frozen'; readonly reason: string | null }

export interface ExecutionAuthorityPort {
  readonly unavailableGroups?: Partial<Record<ExecutionGroup, string>>
  readonly mode: 'standalone' | 'crewstation'
  current(): ExecutionAuthorityState
  /** Resolves with the fence the first time this instance becomes active. */
  whenActive(): Promise<ExecutionFence>
  /** Called once if an active instance stops being active. Returns an unsubscribe. */
  onLost(listener: (state: ExecutionAuthorityState) => void): () => void
  close(): Promise<void>
}
