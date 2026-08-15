import type { UserAccessAuditTransactionParticipant } from './userAccessAuditRepository'
import type { UserAccessTransactionParticipant } from './userAccessRepository'
import type { NotPromise } from '@/db/txSync'

export type UserAccessTransaction = UserAccessTransactionParticipant &
  UserAccessAuditTransactionParticipant

export interface UserAccessTransactionRunner {
  run<T>(body: (transaction: UserAccessTransaction) => NotPromise<T>): T
}
