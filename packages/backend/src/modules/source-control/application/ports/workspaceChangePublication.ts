// RFC-475 — the contract of the workspace change publication (RFC-075 automatic
// commit&push, the git half). Source Control stages, commits and publishes one
// task workspace inside one RFC-321 transport session; the caller (task-execution)
// supplies the commit message author, the write lock and the logger and keeps its
// own node-run and effect bookkeeping. Every port is a closed interface (methods,
// no function-typed properties, no daemon Logger) so it can cross the public
// boundary without widening the contract.
import type { CommitPushMeta, RepositoryCredentialSubject } from '@agent-workflow/shared'

/** What the message author sees for the first commit message. */
export interface WorkspaceChangeMessageContext {
  readonly repoName: string
  readonly branch: string
  readonly baseRef: string
  readonly stat: string
  readonly diffTruncated: string
}

/** What the message author sees when the remote rejected a push. */
export interface WorkspaceChangeRepairContext {
  readonly branch: string
  readonly stat: string
  readonly pushStderr: string
  readonly currentMessage: string
  readonly priorAttempts: number
}

export interface WorkspaceChangeMessage {
  /** null → the deterministic fallback message stays. */
  readonly message: string | null
  /** The author's child may still be alive; no git mutation or replacement is safe. */
  readonly processUnreaped?: true
}

export interface WorkspaceChangeMessageAuthor {
  compose(context: WorkspaceChangeMessageContext): Promise<WorkspaceChangeMessage>
  repair(context: WorkspaceChangeRepairContext): Promise<WorkspaceChangeMessage>
}

export interface WorkspaceWriteLease {
  release(): void
}

/**
 * RFC-076 C4 — the caller's workspace write lock. Held around the index capture
 * and again around each local commit; released during message generation and
 * every network step.
 */
export interface WorkspaceWriteLock {
  acquire(): Promise<WorkspaceWriteLease>
}

/** Closed log fields (same keys the publication always logged). */
export type RepositoryPublicationLogFields = Readonly<{
  nodeRunId?: string
  error?: string
  branch?: string
  credentialSource?: string
  subPath?: string
}>

export interface RepositoryPublicationLogger {
  warn(message: string, fields?: RepositoryPublicationLogFields): void
}

export interface WorkspaceChangePublicationRequest {
  /** The caller's id for this attempt (task-execution: the commit node run); diagnostics only. */
  readonly nodeRunId: string
  /** The two labels of the deterministic fallback message. */
  readonly taskId: string
  readonly agentName: string
  /** Local branch to commit on and push. */
  readonly branch: string
  /** Base ref the workspace was branched from (fallback push base, message context). */
  readonly baseRef: string
  readonly remote: string
  readonly subject: RepositoryCredentialSubject
  /** Commit identity; both blank → the fixed platform identity. */
  readonly authorName: string | null
  readonly authorEmail: string | null
  /** RFC-308: one immutable exclusion slice for the whole attempt. */
  readonly excludePatterns: readonly string[]
  readonly maxRepairRetries: number
  readonly diffMaxBytes: number
  readonly author: WorkspaceChangeMessageAuthor
  /** Omit → no lock (single-writer callers). */
  readonly writeLock?: WorkspaceWriteLock
}

export interface WorkspaceChangePublicationResult {
  readonly meta: CommitPushMeta
  readonly processUnreaped?: true
}

export interface WorkspaceChangePublicationParticipant {
  publish(request: WorkspaceChangePublicationRequest): Promise<WorkspaceChangePublicationResult>
}
