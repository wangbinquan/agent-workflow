import type { TaskResourceRecoveryGrant } from './taskRecoveryWritePurposes'

/** The original receiver/function pair identifies one selected execution lifetime. */
export interface TaskProviderExecutionAuthority {
  current(): boolean
  readonly whenActive?: Promise<boolean>
  readonly canDispatch?: () => boolean
  readonly reportFailure?: (error: unknown) => void
  readonly recoveryGrant?: TaskResourceRecoveryGrant
}

/** Task-owned stop faces; loss never substitutes the normal cancellation policy. */
export interface TaskProviderAuthorityRuntime {
  pause(): Promise<void>
  quiesceAuthorityLoss(): Promise<void>
  drain(): Promise<void>
}
