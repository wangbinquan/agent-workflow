// RFC-480: moved here from public/types — bootstrap hands the factory's reader to development-automation, which names its
// own port (`GraphExecutionFacts`), so no other context names this interface; the infrastructure reader implements it.

/** Committed artifacts of a Case-bound Task; unfinished runs are never exposed. */
export interface EmployeeExecutionArtifactQueries {
  read(input: { readonly caseId: string; readonly executionRef: string }): Promise<{
    readonly taskId: string
    readonly roundRef: string
    readonly status: string
    readonly artifacts: readonly {
      readonly nodeRunId: string
      readonly portName: string
      readonly content: string
      readonly digest: string
    }[]
    readonly reviewRunIds: readonly string[]
  } | null>
}
