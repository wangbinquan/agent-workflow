/** One isolated candidate index; its physical location belongs to the selected adapter. */
export interface RepositoryPreviewIndexScope {
  run(
    args: readonly string[],
    options?: { readonly literalPathspecs: true },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface RepositoryPreviewIndexPort {
  withIndex<Result>(
    operation: (index: RepositoryPreviewIndexScope) => Promise<Result>,
  ): Promise<Result>
}
