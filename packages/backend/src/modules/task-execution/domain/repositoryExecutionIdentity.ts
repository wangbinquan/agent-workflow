/** Persisted v1 publication identity; mount_path equals the former directory name. */
export function repositoryPublicationOrdinal(agentNodeId: string, mountPath: string): string {
  return `repository-publication:${agentNodeId}:${mountPath}`
}
