import type { ProcessOperationAction, ProcessOperationSubjectKind } from '@agent-workflow/shared'
import type { ProcessOperation } from '../../../domain/process/model'

export interface OperationKey {
  readonly action: ProcessOperationAction
  readonly subjectKind: ProcessOperationSubjectKind
  readonly subjectId: string
  readonly actorUserId: string
}

export interface NewOperation extends OperationKey {
  readonly id: string
  readonly transport: 'http' | 'mcp'
  readonly at: number
}

/** RFC-616 §5.4 — the one new ledger: what a person did, and when. */
export interface OperationStore {
  /** The newest record of this (action, subject, actor); null when there is none. */
  latest(key: OperationKey): Promise<{ readonly id: string; readonly lastAt: number } | null>
  insert(operation: NewOperation): Promise<void>
  /** Move a session record's last-seen time forward. */
  touch(id: string, lastAt: number): Promise<void>
  /** Records against the subjects (≤ 500), optionally of the given actions only. */
  bySubjects(
    subjectKind: ProcessOperationSubjectKind,
    subjectIds: readonly string[],
    actions?: readonly ProcessOperationAction[],
  ): Promise<readonly ProcessOperation[]>
}
