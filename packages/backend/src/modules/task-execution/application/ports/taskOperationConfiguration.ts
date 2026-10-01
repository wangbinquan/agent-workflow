/** Configuration facts needed at operation/mint time. The selected adapter
 * reads current settings; Task Execution owns freezing and fallback rules. */
export interface TaskOperationConfigurationQueries {
  readBinaryPaths():
    | { readonly opencodePath?: string | null; readonly claudeCodePath?: string | null }
    | Promise<{ readonly opencodePath?: string | null; readonly claudeCodePath?: string | null }>
  readCommitExcludePatterns(): readonly string[] | Promise<readonly string[]>
}
