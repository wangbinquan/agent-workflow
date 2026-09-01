/** Provider-neutral lookup for the daemon-owned local checkout of a repository. */
export interface RepositoryLocationRead {
  localPath(repositoryId: string): Promise<string | null>
}
