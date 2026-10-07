/** The original receiver/function pair identifies one selected execution lifetime. */
export interface TaskProviderExecutionAuthority {
  current(): boolean
}

/** Task-owned stop faces; loss never substitutes the normal cancellation policy. */
export interface TaskProviderAuthorityRuntime {
  pause(): Promise<void>
  quiesceAuthorityLoss(): Promise<void>
  drain(): Promise<void>
}
