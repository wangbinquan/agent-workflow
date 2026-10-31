/** Source Control supplies the mirror path at the existing preparation cleanup step. */
export interface RepositoryPreparationLookup {
  findLocalPath(cachedRepoId: string): Promise<string | null>
}
