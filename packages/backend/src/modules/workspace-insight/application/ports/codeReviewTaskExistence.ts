// RFC-395 II-b O3 — bootstrap supplies existence facts from each resource owner: which of the code-review
// publication scopes still name a task. RFC-453: moved from code-capability's existing-resource ports with the
// hosted code-review sweep that consumes it.

export interface CodeReviewTaskExistence {
  existingTaskIds(ids: readonly string[]): Promise<ReadonlySet<string>>
}
