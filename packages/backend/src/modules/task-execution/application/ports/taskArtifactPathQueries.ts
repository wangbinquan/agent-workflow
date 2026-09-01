/** Provider-neutral roster of archived/platform paths which full workspace snapshots must force. */
export interface TaskArtifactPathQueries {
  forcedPaths(taskId: string): Promise<readonly string[]>
}
