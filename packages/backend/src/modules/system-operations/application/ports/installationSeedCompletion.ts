/** Installation facts only. The seed orchestrator decides when all owners have
 * finished and when a failed, incomplete offer must be retried. */
export interface InstallationSeedCompletionPort {
  hasCompleted(): boolean | Promise<boolean>
  recordCompleted(completedAt: number): void | Promise<void>
}
