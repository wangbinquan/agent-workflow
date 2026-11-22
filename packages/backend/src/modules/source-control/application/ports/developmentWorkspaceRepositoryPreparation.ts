// RFC-531 — the development workspace repository preparation port: fetch the registered repository and check that its
// configured default branch is fresh before a Digital Employee baseline is frozen. Both profiles implement it
// (standalone: the daemon's mirror cache; hosted: the task volume), so it is defined here rather than beside the local
// implementation that used to declare it.
export interface DevelopmentWorkspaceRepositoryPreparation {
  prepare(input: { readonly repositoryId: string }): Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
}
