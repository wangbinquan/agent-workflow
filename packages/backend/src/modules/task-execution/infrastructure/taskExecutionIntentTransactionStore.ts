import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { CanonicalContinuationRequest } from '../domain/executionIntent'
import type { SubmittedTaskExecutionIntent } from '../application/ports/taskExecutionIntentPersistence'
export type { SubmittedTaskExecutionIntent } from '../application/ports/taskExecutionIntentPersistence'

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
