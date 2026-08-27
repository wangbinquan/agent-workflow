import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  CanonicalContinuationRequest,
  TaskExecutionIntentState,
} from '../../domain/executionIntent'

export interface SubmittedTaskExecutionIntent {
  readonly intentId: string
  readonly state: TaskExecutionIntentState
  readonly idempotent: boolean
  readonly requestHash: string
}

export interface TaskExecutionIntentStore {
  hasPendingGateSuccessor(input: { db: DbClient; taskId: string }): boolean
  submit(input: {
    db: DbClient
    request: CanonicalContinuationRequest
    intentId?: string
    replayAuthorizationId?: string | null
    authorizationScopeJson?: string | null
    admissionMode?: 'exclusive' | 'successor-after-claimed'
    now?: number
  }): SubmittedTaskExecutionIntent
  submitTx(input: {
    tx: DbTxSync
    request: CanonicalContinuationRequest
    intentId: string
    replayAuthorizationId: string | null
    authorizationScopeJson: string | null
    admissionMode?: 'exclusive' | 'successor-after-claimed'
    now: number
  }): SubmittedTaskExecutionIntent
}
