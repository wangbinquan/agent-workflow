// RFC-395 II-b O3 — bootstrap supplies existence facts from each resource owner.
export interface CapabilityAgentExistence {
  existingIds(ids: readonly string[]): Promise<readonly string[]>
}

export interface CodeReviewTaskExistence {
  existingTaskIds(ids: readonly string[]): Promise<ReadonlySet<string>>
}
